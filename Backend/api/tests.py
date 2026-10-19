import asyncio
import json
import uuid
from base64 import b64encode
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from datetime import timedelta
from threading import Barrier
from time import time
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from urllib.parse import urlsplit

from channels.db import database_sync_to_async
from channels.layers import get_channel_layer
from channels.testing import WebsocketCommunicator
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.core.management import call_command
from django.db import (
    IntegrityError, OperationalError, close_old_connections, connection, transaction,
)
from django.test import TransactionTestCase, override_settings
from django.utils import timezone
from google.auth import crypt as google_crypt, jwt as google_jwt
from google.auth.exceptions import GoogleAuthError, TransportError
from rest_framework.authtoken.models import Token
from rest_framework.test import APIClient, APITestCase

from .models import ContaGoogle, Conversa, Mensagem
from .views import (
    MensagemThrottle, enviar_mensagem, grupo_usuario, publicar_evento,
    registrar_resposta_assistente,
)


@override_settings(PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"])
class ProtecaoAutenticacaoTests(APITestCase):
    @classmethod
    def setUpClass(cls):
        call_command("createcachetable", verbosity=0)
        super().setUpClass()

    @classmethod
    def setUpTestData(cls):
        cls.password = "SenhaForte!93q8z7"
        cls.usuario = get_user_model().objects.create_user(
            username="usuario_teste", password=cls.password
        )

    def setUp(self):
        cache.clear()

    def login(self, password=None, ip="192.0.2.1", **headers):
        return self.client.post(
            "/login/",
            {"username": self.usuario.username,
             "password": self.password if password is None else password},
            format="json", REMOTE_ADDR=ip, **headers,
        )

    def test_login_limitado_a_20_requisicoes_por_minuto_por_ip(self):
        for _ in range(20):
            self.assertEqual(self.login().status_code, 200)
        resposta = self.login()
        self.assertEqual(resposta.status_code, 429)
        self.assertGreater(int(resposta["Retry-After"]), 0)
        self.assertEqual(self.login(ip="192.0.2.2").status_code, 200)

    def test_cadastro_limitado_a_5_requisicoes_por_hora(self):
        for _ in range(5):
            resposta = self.client.post("/usuarios/", {}, format="json", REMOTE_ADDR="192.0.2.1")
            self.assertEqual(resposta.status_code, 400)
        resposta = self.client.post("/usuarios/", {}, format="json", REMOTE_ADDR="192.0.2.1")
        self.assertEqual(resposta.status_code, 429)
        self.assertEqual(self.login().status_code, 200)

    def test_x_forwarded_for_nao_contorna_limite(self):
        for indice in range(20):
            self.assertEqual(self.login(HTTP_X_FORWARDED_FOR=f"198.51.100.{indice}").status_code, 200)
        self.assertEqual(self.login(HTTP_X_FORWARDED_FOR="203.0.113.1").status_code, 429)

    def test_cota_de_login_reabre_apos_um_minuto(self):
        agora = time()
        with patch("rest_framework.throttling.SimpleRateThrottle.timer", return_value=agora):
            for _ in range(20):
                self.assertEqual(self.login().status_code, 200)
            self.assertEqual(self.login().status_code, 429)
        with patch("rest_framework.throttling.SimpleRateThrottle.timer", return_value=agora + 60):
            self.assertEqual(self.login().status_code, 200)

    def test_cota_de_cadastro_reabre_apos_uma_hora(self):
        agora = time()
        with patch("rest_framework.throttling.SimpleRateThrottle.timer", return_value=agora):
            for _ in range(5):
                self.client.post("/usuarios/", {}, format="json", REMOTE_ADDR="192.0.2.1")
            resposta = self.client.post("/usuarios/", {}, format="json", REMOTE_ADDR="192.0.2.1")
            self.assertEqual(resposta.status_code, 429)
        with patch("rest_framework.throttling.SimpleRateThrottle.timer", return_value=agora + 3600):
            resposta = self.client.post("/usuarios/", {}, format="json", REMOTE_ADDR="192.0.2.1")
            self.assertEqual(resposta.status_code, 400)

    def test_quinto_erro_bloqueia_conta_e_nao_emite_token(self):
        for _ in range(4):
            self.assertEqual(self.login(password="errada").status_code, 401)
        resposta = self.login(password="errada")
        self.assertEqual(resposta.status_code, 429)
        self.assertIn("bloqueado", resposta.json()["detail"])
        self.assertEqual(self.login(ip="192.0.2.2").status_code, 429)
        self.assertFalse(Token.objects.filter(user=self.usuario).exists())

    def test_trocar_ip_navegador_e_cookie_nao_contorna_bloqueio(self):
        for indice in range(5):
            resposta = self.login(
                password="errada", ip=f"192.0.2.{indice + 1}",
                HTTP_USER_AGENT=f"navegador-{indice}", HTTP_COOKIE=f"teste={indice}",
            )
            self.assertEqual(resposta.status_code, 401 if indice < 4 else 429)
        self.assertEqual(self.login(ip="198.51.100.1").status_code, 429)
        outro_usuario = get_user_model().objects.create_user(
            username="outro_usuario", password=self.password,
        )
        resposta = self.client.post(
            "/login/", {"username": outro_usuario.username, "password": self.password},
            format="json", REMOTE_ADDR="192.0.2.1",
        )
        self.assertEqual(resposta.status_code, 200)

    def test_bloqueio_expira_em_15_minutos_sem_prorrogacao(self):
        agora = timezone.now()
        with patch("axes.handlers.proxy.now", return_value=agora):
            for _ in range(5):
                self.login(password="errada")
        with patch("axes.handlers.proxy.now", return_value=agora + timedelta(minutes=14)):
            self.assertEqual(self.login(password="errada").status_code, 429)
            self.assertEqual(self.login().status_code, 429)
        with patch("axes.handlers.proxy.now", return_value=agora + timedelta(minutes=15, seconds=1)):
            self.assertEqual(self.login().status_code, 200)

    def test_login_correto_limpa_erros_anteriores(self):
        for _ in range(4):
            self.assertEqual(self.login(password="errada").status_code, 401)
        self.assertEqual(self.login().status_code, 200)
        for _ in range(4):
            self.assertEqual(self.login(password="errada").status_code, 401)
        self.assertEqual(self.login(password="errada").status_code, 429)

    def test_usuario_inexistente_recebe_mesmo_bloqueio(self):
        for indice in range(5):
            resposta = self.client.post(
                "/login/", {"username": "inexistente", "password": "errada"},
                format="json", REMOTE_ADDR="192.0.2.1",
            )
            self.assertEqual(resposta.status_code, 401 if indice < 4 else 429)

    def test_cadastro_seguido_de_login_continua_funcionando(self):
        resposta = self.client.post(
            "/usuarios/", {"username": "novo_usuario", "password": self.password},
            format="json", REMOTE_ADDR="192.0.2.1",
        )
        self.assertEqual(resposta.status_code, 201)
        resposta = self.client.post(
            "/login/", {"username": "novo_usuario", "password": self.password},
            format="json", REMOTE_ADDR="192.0.2.1",
        )
        self.assertEqual(resposta.status_code, 200)
        self.assertIn("token", resposta.json())
        self.assertNotIn("sessionid", resposta.cookies)

    def test_login_substitui_token_expirado_e_invalida_chave_anterior(self):
        token = Token.objects.create(user=self.usuario)
        Token.objects.filter(pk=token.pk).update(created=timezone.now() - timedelta(days=2))
        resposta = self.login()
        self.assertEqual(resposta.status_code, 200)
        self.assertNotEqual(resposta.json()["token"], token.key)
        self.assertEqual(Token.objects.filter(user=self.usuario).count(), 1)
        self.client.credentials(HTTP_AUTHORIZATION=f"Token {token.key}")
        self.assertEqual(self.client.get("/chat/").status_code, 401)
        self.assertNotIn("sessionid", resposta.cookies)

    @override_settings(AUTH_TOKEN_TTL_SECONDS=3600)
    def test_novo_login_nao_prorroga_token_ainda_valido(self):
        token = Token.objects.create(user=self.usuario)
        criado = timezone.now() - timedelta(minutes=30)
        Token.objects.filter(pk=token.pk).update(created=criado)
        resposta = self.login()
        self.assertEqual(resposta.status_code, 200)
        self.assertEqual(resposta.json()["token"], token.key)
        self.assertEqual(Token.objects.get(user=self.usuario).created, criado)

    def test_login_de_usuario_desativado_nao_emite_token(self):
        get_user_model().objects.filter(pk=self.usuario.pk).update(is_active=False)
        self.assertEqual(self.login().status_code, 401)
        self.assertFalse(Token.objects.filter(user=self.usuario).exists())


CONFIG_TESTES = {
    "AUTH_TOKEN_TTL_SECONDS": 3600,
    "PASSWORD_HASHERS": ["django.contrib.auth.hashers.MD5PasswordHasher"],
    "CACHES": {"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}},
    "CHANNEL_LAYERS": {"default": {"BACKEND": "channels.layers.InMemoryChannelLayer"}},
}


@override_settings(**CONFIG_TESTES, GOOGLE_CLIENT_ID="cliente-google.apps.googleusercontent.com")
class LoginGoogleTests(APITestCase):
    def setUp(self):
        cache.clear()
        self.claims = {
            "sub": "123456789012345678901",
            "email": "visitante@example.com",
            "email_verified": True,
            "given_name": "Ana",
            "family_name": "Silva",
        }
        verificador = patch(
            "api.views.id_token.verify_oauth2_token", return_value=self.claims
        )
        self.verificador = verificador.start()
        self.addCleanup(verificador.stop)

    def login(self, dados=None, **headers):
        return self.client.post(
            "/login/google/", {"credential": "id-token-google"} if dados is None else dados,
            format="json", REMOTE_ADDR="192.0.2.10", **headers,
        )

    def verificar_sem_contas(self):
        self.assertEqual(get_user_model().objects.count(), 0)
        self.assertEqual(ContaGoogle.objects.count(), 0)
        self.assertEqual(Token.objects.count(), 0)

    def test_login_cria_conta_com_senha_inutilizavel_e_retorna_token_da_api(self):
        self.claims.update({"is_staff": True, "is_superuser": True})
        resposta = self.login()
        self.assertEqual(resposta.status_code, 200)
        usuario = get_user_model().objects.get()
        conta = ContaGoogle.objects.get()
        self.assertEqual(conta.sub, self.claims["sub"])
        self.assertEqual(conta.usuario_id, usuario.pk)
        self.assertRegex(usuario.username, r"^google_[0-9a-f]{32}$")
        self.assertEqual(usuario.email, "visitante@example.com")
        self.assertEqual((usuario.first_name, usuario.last_name), ("Ana", "Silva"))
        self.assertFalse(usuario.has_usable_password())
        self.assertTrue(usuario.is_active)
        self.assertFalse(usuario.is_staff)
        self.assertFalse(usuario.is_superuser)
        self.assertEqual(resposta.json(), {
            "token": Token.objects.get(user=usuario).key,
            "usuario": {
                "id": usuario.pk, "username": usuario.username, "email": usuario.email,
            },
        })
        argumentos, opcoes = self.verificador.call_args
        self.assertEqual(argumentos[0], "id-token-google")
        audience = opcoes.get("audience", argumentos[2] if len(argumentos) > 2 else None)
        self.assertEqual(audience, "cliente-google.apps.googleusercontent.com")
        self.assertNotIn("sessionid", resposta.cookies)

    def test_nomes_sao_limitados_a_150_caracteres(self):
        self.claims.update({"given_name": "A" * 151, "family_name": "B" * 151})
        self.assertEqual(self.login().status_code, 200)
        usuario = get_user_model().objects.get()
        self.assertEqual(usuario.first_name, "A" * 150)
        self.assertEqual(usuario.last_name, "B" * 150)

    def test_nomes_opcionais_nao_impedem_login(self):
        self.claims.pop("given_name")
        self.claims.pop("family_name")
        self.assertEqual(self.login().status_code, 200)
        usuario = get_user_model().objects.get()
        self.assertEqual((usuario.first_name, usuario.last_name), ("", ""))

    def test_mesmo_sub_reutiliza_usuario_e_token_mesmo_com_email_alterado(self):
        primeira = self.login()
        self.assertEqual(primeira.status_code, 200)
        criado = Token.objects.get().created
        self.claims["email"] = "novo-email@example.com"
        segunda = self.login()
        self.assertEqual(segunda.status_code, 200)
        self.assertEqual(segunda.json()["token"], primeira.json()["token"])
        self.assertEqual(segunda.json()["usuario"]["id"], primeira.json()["usuario"]["id"])
        self.assertEqual(get_user_model().objects.count(), 1)
        self.assertEqual(ContaGoogle.objects.count(), 1)
        self.assertEqual(Token.objects.count(), 1)
        self.assertEqual(Token.objects.get().created, criado)

    def test_novo_login_google_renova_token_no_limite_exato_de_validade(self):
        primeira = self.login()
        self.assertEqual(primeira.status_code, 200)
        token = Token.objects.get()
        vencimento = token.created + timedelta(hours=1)
        with patch("api.authentication.timezone.now", return_value=vencimento):
            segunda = self.login()
        self.assertEqual(segunda.status_code, 200)
        self.assertNotEqual(segunda.json()["token"], primeira.json()["token"])
        self.assertEqual(segunda.json()["usuario"], primeira.json()["usuario"])
        renovado = Token.objects.get()
        self.assertEqual(renovado.created, vencimento)
        self.assertEqual(get_user_model().objects.count(), 1)
        self.assertEqual(ContaGoogle.objects.count(), 1)
        self.client.credentials(HTTP_AUTHORIZATION=f"Token {token.key}")
        self.assertEqual(self.client.get("/chat/").status_code, 401)
        self.client.credentials(HTTP_AUTHORIZATION=f"Token {renovado.key}")
        self.assertEqual(self.client.get("/chat/").status_code, 200)
        self.assertNotIn("sessionid", segunda.cookies)

    def test_email_de_contas_locais_inclusive_admin_nao_associa_usuarios(self):
        usuarios = get_user_model()
        local = usuarios.objects.create_user(username="local", email=self.claims["email"])
        admin = usuarios.objects.create_superuser(username="admin", email=self.claims["email"])
        resposta = self.login()
        self.assertEqual(resposta.status_code, 200)
        usuario_google = usuarios.objects.get(pk=resposta.json()["usuario"]["id"])
        self.assertNotIn(usuario_google.pk, (local.pk, admin.pk))
        self.assertFalse(usuario_google.is_staff)
        self.assertFalse(usuario_google.is_superuser)
        self.assertEqual(usuarios.objects.count(), 3)
        self.assertFalse(Token.objects.filter(user__in=(local, admin)).exists())

    def test_dois_subs_com_mesmo_email_criam_contas_distintas(self):
        primeira = self.login()
        self.claims["sub"] = "outro-sub-google"
        segunda = self.login()
        self.assertEqual((primeira.status_code, segunda.status_code), (200, 200))
        self.assertNotEqual(primeira.json()["usuario"]["id"], segunda.json()["usuario"]["id"])
        self.assertNotEqual(primeira.json()["token"], segunda.json()["token"])
        self.assertEqual(get_user_model().objects.count(), 2)
        self.assertEqual(ContaGoogle.objects.count(), 2)

    def test_usuario_vinculado_inativo_nao_recebe_token(self):
        usuario = get_user_model().objects.create_user(username="inativo", is_active=False)
        ContaGoogle.objects.create(sub=self.claims["sub"], usuario=usuario)
        resposta = self.login()
        self.assertEqual(resposta.status_code, 401)
        self.assertFalse(Token.objects.exists())
        self.assertEqual(get_user_model().objects.count(), 1)

    def test_login_publico_ignora_header_de_token_invalido(self):
        resposta = self.login(HTTP_AUTHORIZATION="Token token-invalido")
        self.assertEqual(resposta.status_code, 200)

    def test_erros_de_verificacao_nao_criam_conta_nem_expoem_detalhes(self):
        for erro in (
            ValueError("assinatura invalida: detalhe interno"),
            ValueError("token expirado: detalhe interno"),
            ValueError("audience incorreta: detalhe interno"),
            ValueError("issuer incorreto: detalhe interno"),
            GoogleAuthError("detalhe interno"),
        ):
            with self.subTest(erro=str(erro)):
                self.verificador.side_effect = erro
                resposta = self.login()
                self.assertEqual(resposta.status_code, 401)
                self.assertNotIn("detalhe interno", str(resposta.json()))
                self.verificar_sem_contas()

    def test_falha_de_transporte_retorna_503_sem_criar_conta(self):
        self.verificador.side_effect = TransportError("detalhe interno")
        resposta = self.login()
        self.assertEqual(resposta.status_code, 503)
        self.assertNotIn("detalhe interno", str(resposta.json()))
        self.verificar_sem_contas()

    @override_settings(GOOGLE_CLIENT_ID="")
    def test_client_id_ausente_desabilita_login_sem_validacao_externa(self):
        resposta = self.login()
        self.assertEqual(resposta.status_code, 503)
        self.verificador.assert_not_called()
        self.verificar_sem_contas()

    def test_claims_invalidas_sao_rejeitadas_sem_criar_contas(self):
        invalidas = (
            {"sub": None}, {"sub": ""}, {"sub": []}, {"sub": 123}, {"sub": "s" * 256},
            {"email": None}, {"email": []}, {"email": 123}, {"email": "invalido"},
            {"email": f"{'a' * 64}@{'b' * 63}.{'c' * 63}.{'d' * 62}"},
            {"email_verified": False}, {"email_verified": "true"}, {"email_verified": 1},
        )
        for alteracao in invalidas:
            with self.subTest(alteracao=alteracao):
                self.verificador.return_value = {**self.claims, **alteracao}
                self.assertEqual(self.login().status_code, 401)
                self.verificar_sem_contas()
        for campo in ("sub", "email", "email_verified"):
            with self.subTest(campo_ausente=campo):
                self.verificador.return_value = {
                    chave: valor for chave, valor in self.claims.items() if chave != campo
                }
                self.assertEqual(self.login().status_code, 401)
                self.verificar_sem_contas()

    def test_limites_validos_de_credential_sub_e_email_sao_aceitos(self):
        self.claims.update({
            "sub": "s" * 255,
            "email": f"{'a' * 64}@{'b' * 63}.{'c' * 63}.{'d' * 61}",
        })
        resposta = self.login({"credential": "x" * 8192})
        self.assertEqual(resposta.status_code, 200)
        self.assertEqual(ContaGoogle.objects.get().sub, self.claims["sub"])
        self.assertEqual(get_user_model().objects.get().email, self.claims["email"])

    def test_payloads_invalidos_retornam_400_sem_verificar_no_google(self):
        for dados in (
            {}, {"credential": None}, {"credential": ""}, {"credential": " "},
            {"credential": []}, {"credential": {}}, {"credential": True},
            {"credential": 123}, {"credential": 1.5}, {"credential": "x" * 8193},
            [], "id-token-google",
        ):
            with self.subTest(dados=str(dados)[:80]):
                self.assertEqual(self.login(dados).status_code, 400)
        self.verificador.assert_not_called()
        self.verificar_sem_contas()

    def test_aceita_apenas_post_json(self):
        formulario = self.client.post("/login/google/", {"credential": "id-token-google"})
        self.assertEqual(formulario.status_code, 415)
        self.assertEqual(self.client.get("/login/google/").status_code, 405)
        invalido = self.client.post(
            "/login/google/", '{"credential":', content_type="application/json"
        )
        self.assertEqual(invalido.status_code, 400)
        self.verificador.assert_not_called()
        self.verificar_sem_contas()

    def test_falha_ao_gravar_vinculo_reverte_criacao_do_usuario(self):
        with patch.object(ContaGoogle, "save", side_effect=IntegrityError("detalhe interno")):
            resposta = self.login()
        self.assertEqual(resposta.status_code, 503)
        self.assertNotIn("detalhe interno", str(resposta.json()))
        self.verificar_sem_contas()

    def test_banco_indisponivel_retorna_503_sem_expor_detalhes(self):
        with patch(
            "django.db.backends.utils.CursorWrapper.execute",
            side_effect=OperationalError("detalhe interno"),
        ):
            resposta = self.login()
        self.assertEqual(resposta.status_code, 503)
        self.assertNotIn("detalhe interno", str(resposta.json()))
        self.verificar_sem_contas()

    def test_limite_por_ip_e_compartilhado_com_login_por_senha(self):
        usuario = get_user_model().objects.create_user(username="local", password="Senha93!")
        for _ in range(19):
            self.assertEqual(self.login().status_code, 200)
        resposta_local = self.client.post(
            "/login/", {"username": usuario.username, "password": "Senha93!"},
            format="json", REMOTE_ADDR="192.0.2.10",
        )
        self.assertEqual(resposta_local.status_code, 200)
        self.verificador.reset_mock()
        limitada = self.login()
        self.assertEqual(limitada.status_code, 429)
        self.assertGreater(int(limitada["Retry-After"]), 0)
        self.verificador.assert_not_called()
        outro_ip = self.client.post(
            "/login/google/", {"credential": "id-token-google"},
            format="json", REMOTE_ADDR="192.0.2.11",
        )
        self.assertEqual(outro_ip.status_code, 200)

    def test_token_google_autentica_chat_e_logout_revoga_acesso(self):
        login = self.login()
        self.assertEqual(login.status_code, 200)
        token = login.json()["token"]
        self.client.credentials(HTTP_AUTHORIZATION=f"Token {token}")
        chat = self.client.get("/chat/")
        self.assertEqual(chat.status_code, 200)
        self.assertEqual(chat.json()["usuario"]["id"], login.json()["usuario"]["id"])
        self.assertFalse(chat.json()["operador"])
        self.assertEqual(self.client.post("/logout/").status_code, 204)
        self.assertFalse(Token.objects.filter(key=token).exists())
        self.assertEqual(self.client.get("/chat/").status_code, 401)
        self.client.credentials()
        novo_login = self.login()
        self.assertEqual(novo_login.status_code, 200)
        self.assertNotEqual(novo_login.json()["token"], token)
        self.assertEqual(get_user_model().objects.count(), 1)


@override_settings(**CONFIG_TESTES, GOOGLE_CLIENT_ID="cliente-google.apps.googleusercontent.com")
class LoginGoogleTokensAssinadosTests(APITestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        chave = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        cls.assinador = google_crypt.RSASigner(chave, key_id="chave-teste")
        cls.certificados = {
            "chave-teste": chave.public_key().public_bytes(
                serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
            ).decode("ascii"),
        }

    def setUp(self):
        cache.clear()
        agora = int(time())
        self.claims = {
            "sub": "sub-token-assinado", "email": "assinado@example.com",
            "email_verified": True, "iss": "https://accounts.google.com",
            "aud": "cliente-google.apps.googleusercontent.com",
            "iat": agora - 60, "exp": agora + 3600,
        }

    def token(self, alteracoes=None):
        return google_jwt.encode(
            self.assinador, {**self.claims, **(alteracoes or {})}
        ).decode("ascii")

    def login(self, credential):
        resposta_certificados = SimpleNamespace(
            status=200, data=json.dumps(self.certificados).encode("utf-8")
        )
        with patch("api.views.GoogleRequest") as transporte:
            transporte.return_value.return_value = resposta_certificados
            resposta = self.client.post(
                "/login/google/", {"credential": credential}, format="json"
            )
            transporte.return_value.assert_called_once()
            self.assertEqual(transporte.return_value.call_args.kwargs["timeout"], 5)
        return resposta

    def test_token_rsa_valido_passa_pelo_verificador_real_sem_acesso_a_rede(self):
        resposta = self.login(self.token())
        self.assertEqual(resposta.status_code, 200)
        self.assertEqual(ContaGoogle.objects.get().sub, self.claims["sub"])
        self.assertEqual(Token.objects.get().key, resposta.json()["token"])

    def test_assinatura_audience_issuer_e_expiracao_invalidas_sao_rejeitadas(self):
        cabecalho, corpo, assinatura = self.token().split(".")
        assinatura_invalida = ("A" if assinatura[0] != "A" else "B") + assinatura[1:]
        credenciais = {
            "assinatura": f"{cabecalho}.{corpo}.{assinatura_invalida}",
            "audience": self.token({"aud": "outro-cliente.apps.googleusercontent.com"}),
            "issuer": self.token({"iss": "https://outro.example.com"}),
            "expiracao": self.token({"exp": int(time()) - 1}),
        }
        for motivo, credential in credenciais.items():
            with self.subTest(motivo=motivo):
                resposta = self.login(credential)
                self.assertEqual(resposta.status_code, 401)
                self.assertFalse(get_user_model().objects.exists())
                self.assertFalse(ContaGoogle.objects.exists())
                self.assertFalse(Token.objects.exists())


@override_settings(**CONFIG_TESTES, GOOGLE_CLIENT_ID="cliente-google.apps.googleusercontent.com")
class LoginGoogleConcorrenciaTests(TransactionTestCase):
    def setUp(self):
        cache.clear()
        self.client = APIClient()

    def test_mesmo_sub_em_conexoes_distintas_nao_duplica_usuario_nem_vinculo(self):
        barreira = Barrier(2)
        claims = {
            "sub": "sub-google-concorrente", "email": "concorrente@example.com",
            "email_verified": True,
        }

        def verificar(*args, **kwargs):
            barreira.wait(timeout=5)
            return claims.copy()

        def enviar():
            close_old_connections()
            try:
                connection.ensure_connection()
                conexao = id(connection.connection)
                resposta = APIClient().post(
                    "/login/google/", {"credential": "id-token-google"},
                    format="json", REMOTE_ADDR="192.0.2.20",
                )
                return conexao, resposta.status_code, resposta.json()
            finally:
                close_old_connections()

        with patch("api.views.id_token.verify_oauth2_token", side_effect=verificar):
            with ThreadPoolExecutor(max_workers=2) as executor:
                tarefas = [executor.submit(enviar) for _ in range(2)]
                respostas = [tarefa.result(timeout=15) for tarefa in tarefas]
        self.assertEqual(len({conexao for conexao, _, _ in respostas}), 2)
        self.assertTrue(all(status in (200, 503) for _, status, _ in respostas), respostas)
        with patch("api.views.id_token.verify_oauth2_token", return_value=claims):
            repetida = self.client.post(
                "/login/google/", {"credential": "id-token-google"}, format="json"
            )
        self.assertEqual(repetida.status_code, 200)
        self.assertEqual(get_user_model().objects.count(), 1)
        self.assertEqual(ContaGoogle.objects.count(), 1)
        self.assertEqual(Token.objects.count(), 1)
        conta = ContaGoogle.objects.get()
        self.assertEqual(conta.sub, claims["sub"])
        self.assertEqual(conta.usuario_id, repetida.json()["usuario"]["id"])
        for _, status, dados in respostas:
            if status == 200:
                self.assertEqual(dados["token"], repetida.json()["token"])
                self.assertEqual(dados["usuario"]["id"], conta.usuario_id)


@override_settings(**CONFIG_TESTES, GOOGLE_CLIENT_ID="cliente-google.apps.googleusercontent.com")
class TokenExpiracaoConcorrenciaTests(TransactionTestCase):
    def setUp(self):
        cache.clear()
        self.password = "SenhaForte!93q8z7"
        self.usuario = get_user_model().objects.create_user(
            username="tokens_concorrentes", password=self.password,
        )
        ContaGoogle.objects.create(usuario=self.usuario, sub="sub-token-concorrente")
        self.token = Token.objects.create(user=self.usuario)
        Token.objects.filter(pk=self.token.pk).update(
            created=timezone.now() - timedelta(days=2)
        )

    def test_logins_senha_e_google_concorrentes_compartilham_uma_unica_renovacao(self):
        from .authentication import obter_token_acesso

        barreira = Barrier(2)

        def obter_sincronizado(usuario):
            barreira.wait(timeout=5)
            return obter_token_acesso(usuario)

        def enviar(tipo):
            close_old_connections()
            try:
                connection.ensure_connection()
                conexao = id(connection.connection)
                if tipo == "senha":
                    caminho = "/login/"
                    dados = {"username": self.usuario.username, "password": self.password}
                else:
                    caminho = "/login/google/"
                    dados = {"credential": "id-token-google"}
                resposta = APIClient().post(
                    caminho, dados, format="json", REMOTE_ADDR="192.0.2.30",
                )
                return conexao, resposta.status_code, resposta.json()
            finally:
                close_old_connections()

        claims = {
            "sub": "sub-token-concorrente", "email": "concorrente@example.com",
            "email_verified": True,
        }
        with (
            patch("api.views.id_token.verify_oauth2_token", return_value=claims),
            patch("api.views.obter_token_acesso", side_effect=obter_sincronizado),
            ThreadPoolExecutor(max_workers=2) as executor,
        ):
            tarefas = [executor.submit(enviar, tipo) for tipo in ("senha", "google")]
            respostas = [tarefa.result(timeout=15) for tarefa in tarefas]

        self.assertEqual(len({conexao for conexao, _, _ in respostas}), 2)
        self.assertTrue(all(status in (200, 503) for _, status, _ in respostas), respostas)
        repetida = APIClient().post(
            "/login/", {"username": self.usuario.username, "password": self.password},
            format="json", REMOTE_ADDR="192.0.2.31",
        )
        self.assertEqual(repetida.status_code, 200)
        renovado = Token.objects.get(user=self.usuario)
        self.assertNotEqual(renovado.key, self.token.key)
        self.assertEqual(Token.objects.count(), 1)
        self.assertFalse(Token.objects.filter(key=self.token.key).exists())
        for _, status, dados in respostas:
            if status == 200:
                self.assertEqual(dados["token"], repetida.json()["token"])
            else:
                self.assertNotIn("database", str(dados).lower())
        cliente = APIClient()
        cliente.credentials(HTTP_AUTHORIZATION=f"Token {self.token.key}")
        self.assertEqual(cliente.get("/chat/").status_code, 401)
        cliente.credentials(HTTP_AUTHORIZATION=f"Token {renovado.key}")
        self.assertEqual(cliente.get("/chat/").status_code, 200)


class DadosChatMixin:
    def preparar_dados(self):
        cache.clear()
        usuarios = get_user_model()
        self.usuario = usuarios.objects.create_user(
            username="visitante_a", email="privado@example.com", password="SenhaForte!93q8z7"
        )
        self.outro = usuarios.objects.create_user(username="visitante_b")
        self.operador = usuarios.objects.create_superuser(username="administrador_a")
        self.operador2 = usuarios.objects.create_superuser(username="outra_conta_admin")
        self.token = Token.objects.create(user=self.usuario)
        self.token_outro = Token.objects.create(user=self.outro)
        self.token_operador = Token.objects.create(user=self.operador)
        self.token_operador2 = Token.objects.create(user=self.operador2)
        self.conversa = Conversa.objects.create(usuario=self.usuario, destinatario="henrique")
        self.assistente = Conversa.objects.create(usuario=self.usuario, destinatario="assistente")
        self.conversa_outro = Conversa.objects.create(usuario=self.outro, destinatario="henrique")
        self.client = APIClient()
        self.autorizar(self.token)

    def autorizar(self, token):
        self.client.credentials(HTTP_AUTHORIZATION=f"Token {token.key}")

    def enviar_http(self, conversa=None, conteudo="Olá!", id_cliente=None, **extras):
        conversa = conversa or self.conversa
        return self.client.post(
            f"/chat/conversas/{conversa.pk}/mensagens/",
            {"conteudo": conteudo, "id_cliente": str(id_cliente or uuid.uuid4()), **extras},
            format="json",
        )

    def leitura_http(self, conversa, mensagem_id):
        return self.client.post(
            f"/chat/conversas/{conversa.pk}/leitura/",
            {"mensagem_id": mensagem_id}, format="json",
        )


@override_settings(**CONFIG_TESTES)
class TokenExpiracaoHTTPTests(DadosChatMixin, APITestCase):
    def setUp(self):
        self.preparar_dados()

    def test_validade_configuravel_rejeita_no_limite_exato_sem_prorrogar(self):
        criado = self.token.created
        for ttl in (60, 3600):
            with self.subTest(ttl=ttl), override_settings(AUTH_TOKEN_TTL_SECONDS=ttl):
                vencimento = criado + timedelta(seconds=ttl)
                with patch(
                    "api.authentication.timezone.now",
                    return_value=vencimento - timedelta(microseconds=1),
                ):
                    self.assertEqual(self.client.get("/chat/").status_code, 200)
                with patch("api.authentication.timezone.now", return_value=vencimento):
                    resposta = self.client.get("/chat/")
                self.assertEqual(resposta.status_code, 401)
                self.assertEqual(resposta["WWW-Authenticate"], "Token")
                self.assertNotIn("sessionid", resposta.cookies)
                self.token.refresh_from_db()
                self.assertEqual(self.token.created, criado)

    def test_token_vencido_nao_le_escreve_faz_logout_ou_cria_sessao(self):
        vencimento = self.token.created + timedelta(hours=1)
        requisicoes = (
            ("get", "/chat/", None),
            ("get", "/chat/conversas/", None),
            ("get", f"/chat/conversas/{self.conversa.pk}/", None),
            ("get", f"/chat/conversas/{self.conversa.pk}/mensagens/", None),
            ("post", "/chat/conversas/", {"destinatario": "henrique"}),
            ("post", f"/chat/conversas/{self.conversa.pk}/mensagens/", {
                "conteudo": "Nao pode gravar", "id_cliente": str(uuid.uuid4()),
            }),
            ("post", f"/chat/conversas/{self.conversa.pk}/leitura/", {"mensagem_id": 1}),
            ("post", "/logout/", {}),
        )
        with patch("api.authentication.timezone.now", return_value=vencimento):
            for metodo, caminho, dados in requisicoes:
                with self.subTest(metodo=metodo, caminho=caminho):
                    enviar = getattr(self.client, metodo)
                    resposta = enviar(caminho) if dados is None else enviar(caminho, dados, format="json")
                    self.assertEqual(resposta.status_code, 401)
                    self.assertNotIn("sessionid", resposta.cookies)
        self.assertEqual(Mensagem.objects.count(), 0)
        self.assertEqual(Conversa.objects.filter(usuario=self.usuario).count(), 2)
        self.assertTrue(Token.objects.filter(key=self.token.key).exists())

    def test_login_senha_renova_no_limite_e_novo_token_autentica(self):
        vencimento = self.token.created + timedelta(hours=1)
        self.client.credentials()
        with patch("api.authentication.timezone.now", return_value=vencimento):
            resposta = self.client.post(
                "/login/", {"username": self.usuario.username, "password": "SenhaForte!93q8z7"},
                format="json",
            )
        self.assertEqual(resposta.status_code, 200)
        renovado = Token.objects.get(user=self.usuario)
        self.assertEqual(renovado.created, vencimento)
        self.assertNotEqual(renovado.key, self.token.key)
        self.autorizar(self.token)
        self.assertEqual(self.client.get("/chat/").status_code, 401)
        self.autorizar(renovado)
        self.assertEqual(self.client.get("/chat/").status_code, 200)
        self.assertNotIn("sessionid", resposta.cookies)

    def test_falha_de_banco_na_autenticacao_e_emissao_e_recuperavel(self):
        with patch.object(Token.objects, "select_related", side_effect=OperationalError("detalhe interno")):
            resposta = self.client.get("/chat/")
        self.assertEqual(resposta.status_code, 503)
        self.assertNotIn("detalhe interno", str(resposta.json()))
        self.client.credentials()
        with patch.object(Token.objects, "get_or_create", side_effect=OperationalError("detalhe interno")):
            resposta = self.client.post(
                "/login/", {"username": self.usuario.username, "password": "SenhaForte!93q8z7"},
                format="json",
            )
        self.assertEqual(resposta.status_code, 503)
        self.assertNotIn("detalhe interno", str(resposta.json()))

    def test_perdedor_da_renovacao_rele_token_ja_emitido_pelo_outro_login(self):
        from django.db.models.query import QuerySet
        from .authentication import obter_token_acesso

        Token.objects.filter(key=self.token.key).update(created=timezone.now() - timedelta(days=2))
        atualizar = QuerySet.update
        criado = timezone.now()

        def simular_vencedor(consulta, **valores):
            atualizar(consulta, key="f" * 40, created=criado)
            return 0

        with patch.object(QuerySet, "update", autospec=True, side_effect=simular_vencedor) as tentativa:
            token = obter_token_acesso(self.usuario)
        tentativa.assert_called_once()
        self.assertEqual(token.key, "f" * 40)
        self.assertEqual(token.created, criado)
        self.assertEqual(Token.objects.filter(user=self.usuario).count(), 1)
        self.assertFalse(Token.objects.filter(key=self.token.key).exists())


@override_settings(**CONFIG_TESTES)
class ChatHTTPTests(DadosChatMixin, APITestCase):
    def setUp(self):
        self.preparar_dados()

    def test_chat_exige_token_e_identifica_papel_sem_depender_do_nome(self):
        self.client.credentials()
        self.assertEqual(self.client.get("/chat/").status_code, 401)
        self.autorizar(self.token)
        resposta = self.client.get("/chat/").json()
        self.assertFalse(resposta["operador"])
        self.assertFalse(resposta["assistente_ia_ativo"])
        self.assertEqual([d["nome"] for d in resposta["destinatarios"]], ["Henrique", "Assistente"])
        for token in (self.token_operador, self.token_operador2):
            self.autorizar(token)
            self.assertTrue(self.client.get("/chat/").json()["operador"])

    def test_duas_conversas_por_usuario_sem_duplicacao(self):
        for destinatario, conversa in (("henrique", self.conversa), ("assistente", self.assistente)):
            resposta = self.client.post("/chat/conversas/", {"destinatario": destinatario}, format="json")
            self.assertEqual(resposta.status_code, 200)
            self.assertEqual(resposta.json()["id"], str(conversa.pk))
        self.autorizar(self.token_outro)
        resposta = self.client.post("/chat/conversas/", {"destinatario": "assistente"}, format="json")
        self.assertEqual(resposta.status_code, 201)
        self.assertEqual(Conversa.objects.filter(usuario=self.outro).count(), 2)

    def test_conversa_rejeita_destinatario_invalido_e_usuario_forjado(self):
        for dados in ({"destinatario": "visitante_b"}, {"destinatario": "henrique", "usuario": self.outro.pk}, []):
            with self.subTest(dados=dados):
                self.assertEqual(self.client.post("/chat/conversas/", dados, format="json").status_code, 400)

    def test_superusuarios_atendem_conversas_recebidas(self):
        self.autorizar(self.token_operador)
        self.assertEqual(self.client.post("/chat/conversas/", {"destinatario": "henrique"}, format="json").status_code, 403)

    def test_listagem_privada_e_caixa_compartilhada_dos_superusuarios(self):
        resposta = self.client.get("/chat/conversas/").json()
        self.assertEqual(resposta["count"], 2)
        self.assertNotIn("privado@example.com", str(resposta))
        for token in (self.token_operador, self.token_operador2):
            self.autorizar(token)
            self.assertEqual(self.client.get("/chat/conversas/").json()["count"], 3)
            filtrada = self.client.get("/chat/conversas/?destinatario=assistente").json()
            self.assertEqual(filtrada["count"], 1)
        self.assertEqual(self.client.get("/chat/conversas/?destinatario=invalido").status_code, 400)

    def test_staff_sem_superuser_nao_acessa_conversa_alheia(self):
        self.usuario.is_staff = True
        self.usuario.save(update_fields=("is_staff",))
        base = f"/chat/conversas/{self.conversa_outro.pk}/"
        self.assertEqual(self.client.get(base).status_code, 404)
        self.assertEqual(self.client.get(base + "mensagens/").status_code, 404)
        self.assertEqual(self.enviar_http(self.conversa_outro).status_code, 404)
        self.assertEqual(self.leitura_http(self.conversa_outro, 1).status_code, 404)
        self.assertFalse(Mensagem.objects.exists())

    def test_nome_henrique_nao_concede_papel_de_atendimento(self):
        self.usuario.username = "Henrique"
        self.usuario.save(update_fields=("username",))
        self.assertFalse(self.client.get("/chat/").json()["operador"])
        self.assertEqual(self.enviar_http(self.conversa_outro).status_code, 404)

    def test_cadastro_publico_nao_concede_superuser_pelo_payload(self):
        resposta = self.client.post("/usuarios/", {
            "username": "tentativa_admin", "password": "SenhaForte!93q8z7",
            "is_superuser": True, "is_staff": True,
        }, format="json")
        self.assertEqual(resposta.status_code, 201)
        usuario = get_user_model().objects.get(username="tentativa_admin")
        self.assertFalse(usuario.is_superuser)
        self.assertFalse(usuario.is_staff)

    def test_enviar_e_recuperar_historico_dos_dois_destinatarios(self):
        for conversa in (self.conversa, self.assistente):
            resposta = self.enviar_http(conversa, "  Olá, tudo bem?  ")
            self.assertEqual(resposta.status_code, 201)
            self.assertEqual(resposta.json()["conteudo"], "Olá, tudo bem?")
            self.assertEqual(resposta.json()["remetente"], {"id": self.usuario.pk, "nome": self.usuario.username})
            historico = self.client.get(f"/chat/conversas/{conversa.pk}/mensagens/").json()
            self.assertEqual(len(historico["results"]), 1)
        self.assertEqual(Mensagem.objects.count(), 2)

    def test_resposta_de_qualquer_superuser_aparece_sempre_como_henrique(self):
        for token in (self.token_operador, self.token_operador2):
            self.autorizar(token)
            for conversa in (self.conversa, self.assistente):
                resposta = self.enviar_http(conversa, "Posso ajudar?")
                self.assertEqual(resposta.status_code, 201)
                self.assertEqual(resposta.json()["origem"], "henrique")
                self.assertEqual(resposta.json()["remetente"], {"id": None, "nome": "Henrique"})
                self.assertNotIn(token.user.username, str(resposta.json()))
                self.assertEqual(Mensagem.objects.get(pk=resposta.json()["id"]).remetente_id, token.user_id)

    def test_usuario_nao_pode_forjar_autor_ou_origem(self):
        for campo, valor in (("origem", "henrique"), ("remetente", self.operador.pk), ("conversa_id", str(self.assistente.pk))):
            with self.subTest(campo=campo):
                self.assertEqual(self.enviar_http(**{campo: valor}).status_code, 400)
        self.assertFalse(Mensagem.objects.exists())

    def test_mensagens_invalidas_nao_sao_salvas(self):
        for conteudo in ("", " \n\t ", "a" * 4001, None, 123, True, [], {}):
            with self.subTest(conteudo=str(conteudo)[:20]):
                self.assertEqual(self.enviar_http(conteudo=conteudo).status_code, 400)
        self.assertFalse(Mensagem.objects.exists())

    def test_id_cliente_obrigatorio_e_uuid_valido(self):
        url = f"/chat/conversas/{self.conversa.pk}/mensagens/"
        for dados in ({"conteudo": "Olá"}, {"conteudo": "Olá", "id_cliente": "invalido"}):
            self.assertEqual(self.client.post(url, dados, format="json").status_code, 400)

    def test_reenvio_retorna_mesma_mensagem_e_conflito_nao_altera_historico(self):
        chave = uuid.uuid4()
        primeira = self.enviar_http(id_cliente=chave)
        repetida = self.enviar_http(id_cliente=chave)
        self.assertEqual(primeira.status_code, 201)
        self.assertEqual(repetida.status_code, 200)
        self.assertEqual(primeira.json()["id"], repetida.json()["id"])
        self.assertEqual(self.enviar_http(id_cliente=chave, conteudo="Outro texto").status_code, 409)
        self.assertEqual(Mensagem.objects.count(), 1)

    def test_id_cliente_isolado_por_conversa_e_origem(self):
        chave = uuid.uuid4()
        self.assertEqual(self.enviar_http(id_cliente=chave).status_code, 201)
        self.assertEqual(self.enviar_http(self.assistente, id_cliente=chave).status_code, 201)
        self.autorizar(self.token_operador)
        self.assertEqual(self.enviar_http(id_cliente=chave).status_code, 201)

    def test_limite_de_mensagem_compartilhado_entre_conversas_e_reenvio_seguro(self):
        with patch.object(MensagemThrottle, "get_rate", return_value="2/min"):
            chave = uuid.uuid4()
            self.assertEqual(self.enviar_http(id_cliente=chave).status_code, 201)
            self.assertEqual(self.enviar_http(self.assistente).status_code, 201)
            limitada = self.enviar_http()
            self.assertEqual(limitada.status_code, 429)
            self.assertGreater(int(limitada["Retry-After"]), 0)
            self.assertEqual(self.enviar_http(id_cliente=chave).status_code, 200)

    def test_historico_paginado_e_recuperacao_apos_reconectar(self):
        mensagens = Mensagem.objects.bulk_create([
            Mensagem(conversa=self.conversa, remetente=self.usuario, origem="usuario", conteudo=f"Mensagem {i}", id_cliente=uuid.uuid4())
            for i in range(55)
        ])
        url = f"/chat/conversas/{self.conversa.pk}/mensagens/"
        primeira = self.client.get(url).json()
        self.assertEqual(len(primeira["results"]), 50)
        self.assertEqual(primeira["results"][0]["id"], mensagens[-1].pk)
        partes = urlsplit(primeira["next"])
        segunda = self.client.get(partes.path + "?" + partes.query).json()
        self.assertEqual(len(segunda["results"]), 5)
        self.assertIsNone(segunda["next"])
        novas = self.client.get(url, {"apos_id": mensagens[-4].pk}).json()
        self.assertEqual([m["id"] for m in novas["results"]], [m.pk for m in mensagens[-3:]])
        self.assertEqual(self.client.get(url, {"apos_id": "invalido"}).status_code, 400)
        self.assertEqual(self.client.get(url, {"cursor": "invalido"}).status_code, 404)

    def test_cursor_com_posicao_adulterada_nao_causa_erro_interno(self):
        url = f"/chat/conversas/{self.conversa.pk}/mensagens/"
        for posicao in ("invalido", "1.1", "-1", "0", "9223372036854775808", "9" * 5000):
            with self.subTest(posicao=posicao[:30]):
                cursor = b64encode(f"p={posicao}".encode()).decode()
                resposta = self.client.get(url, {"cursor": cursor})
                self.assertEqual(resposta.status_code, 404)

    def test_nao_lidas_marcadores_monotonicos_e_leitura_compartilhada(self):
        primeira = self.enviar_http().json()["id"]
        segunda = self.enviar_http(conteudo="Segunda").json()["id"]
        url = f"/chat/conversas/{self.conversa.pk}/"
        self.autorizar(self.token_operador)
        self.assertEqual(self.client.get(url).json()["nao_lidas"], 2)
        self.assertEqual(self.leitura_http(self.conversa, segunda).status_code, 200)
        self.assertEqual(self.leitura_http(self.conversa, primeira).json()["mensagem_id"], segunda)
        self.autorizar(self.token_operador2)
        self.assertEqual(self.client.get(url).json()["nao_lidas"], 0)
        resposta = self.enviar_http(conteudo="Respondido").json()["id"]
        self.autorizar(self.token)
        self.assertEqual(self.client.get(url).json()["nao_lidas"], 1)
        self.assertEqual(self.leitura_http(self.conversa, resposta).status_code, 200)
        self.assertEqual(self.client.get(url).json()["nao_lidas"], 0)

    def test_leitura_rejeita_mensagem_de_outra_conversa(self):
        mensagem = self.enviar_http(self.assistente).json()["id"]
        self.assertEqual(self.leitura_http(self.conversa, mensagem).status_code, 404)
        self.conversa.refresh_from_db()
        self.assertEqual(self.conversa.ultima_lida_usuario, 0)

    def test_estrutura_interna_para_futura_ia_sem_endpoint_de_personificacao(self):
        mensagem, criada = registrar_resposta_assistente(
            self.assistente.pk, {"conteudo": "Resposta futura", "id_cliente": str(uuid.uuid4())}
        )
        self.assertTrue(criada)
        self.assertIsNone(mensagem.remetente_id)
        historico = self.client.get(f"/chat/conversas/{self.assistente.pk}/mensagens/").json()
        self.assertEqual(historico["results"][0]["remetente"], {"id": None, "nome": "Assistente"})
        from django.http import Http404
        with self.assertRaises(Http404):
            registrar_resposta_assistente(self.conversa.pk, {"conteudo": "Não", "id_cliente": str(uuid.uuid4())})

    def test_quando_nao_ha_superusuario_ativo_chat_nao_aceita_novos_envios(self):
        get_user_model().objects.filter(is_superuser=True).update(is_active=False)
        self.assertEqual(self.enviar_http().status_code, 503)
        self.assertFalse(Mensagem.objects.exists())

    def test_usuario_inativo_e_token_revogado_nao_acessam_chat(self):
        self.usuario.is_active = False
        self.usuario.save(update_fields=("is_active",))
        self.assertEqual(self.client.get("/chat/conversas/").status_code, 401)
        self.usuario.is_active = True
        self.usuario.save(update_fields=("is_active",))
        self.assertEqual(self.client.post("/logout/").status_code, 204)
        self.assertFalse(Token.objects.filter(pk=self.token.pk).exists())
        self.assertEqual(self.client.get("/chat/").status_code, 401)

    def test_logout_revoga_acesso_mesmo_com_cota_do_chat_esgotada(self):
        with patch("api.views.ScopedRateThrottle.get_rate", return_value="1/min"):
            self.assertEqual(self.client.get("/chat/").status_code, 200)
            self.assertEqual(self.client.get("/chat/").status_code, 429)
            self.assertEqual(self.client.post("/logout/").status_code, 204)
        self.assertFalse(Token.objects.filter(pk=self.token.pk).exists())

    def test_falha_de_publicacao_nao_perde_mensagem_confirmada_no_banco(self):
        with patch("api.views.get_channel_layer") as camada:
            camada.return_value.group_send = AsyncMock(side_effect=ConnectionError())
            with self.assertLogs("api.views", level="WARNING"):
                with self.captureOnCommitCallbacks(execute=True):
                    resposta = self.enviar_http()
        self.assertEqual(resposta.status_code, 201)
        self.assertEqual(Mensagem.objects.count(), 1)

    def test_falha_de_banco_vira_erro_recuperavel_sem_detalhes_internos(self):
        from django.db import OperationalError
        with patch("api.views.enviar_mensagem", side_effect=OperationalError("detalhe interno")):
            resposta = self.enviar_http()
        self.assertEqual(resposta.status_code, 503)
        self.assertNotIn("detalhe interno", str(resposta.json()))

    def test_falha_em_um_grupo_nao_interrompe_publicacao_aos_demais(self):
        with patch("api.views.get_channel_layer") as camada:
            camada.return_value.group_send = AsyncMock(side_effect=[ConnectionError(), None, None])
            with self.assertLogs("api.views", level="WARNING"):
                publicar_evento((self.usuario.pk, self.operador.pk, self.operador2.pk), {"type": "teste"})
            self.assertEqual(camada.return_value.group_send.await_count, 3)

    def test_integridade_da_conversa_e_da_identidade_no_banco(self):
        with self.assertRaises(IntegrityError), transaction.atomic():
            Conversa.objects.create(usuario=self.usuario, destinatario="henrique")
        with self.assertRaises(IntegrityError), transaction.atomic():
            Conversa.objects.create(usuario=self.usuario, destinatario="invalido")
        with self.assertRaises(IntegrityError), transaction.atomic():
            Mensagem.objects.create(conversa=self.conversa, origem="henrique", conteudo="Falso", id_cliente=uuid.uuid4())

    def test_metodos_de_edicao_e_exclusao_nao_expostos(self):
        url = f"/chat/conversas/{self.conversa.pk}/"
        self.assertEqual(self.client.delete(url).status_code, 405)
        self.assertEqual(self.client.patch(url, {}, format="json").status_code, 405)


@override_settings(**CONFIG_TESTES)
class ChatConcorrenciaTests(DadosChatMixin, TransactionTestCase):
    def setUp(self):
        self.preparar_dados()

    def executar_em_paralelo(self, url, dados):
        barreira = Barrier(2)

        def enviar():
            close_old_connections()
            cliente = APIClient()
            cliente.credentials(HTTP_AUTHORIZATION=f"Token {self.token.key}")
            try:
                barreira.wait(timeout=5)
                return cliente.post(url, dados, format="json").status_code
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=2) as executor:
            tarefas = [executor.submit(enviar) for _ in range(2)]
            return [tarefa.result(timeout=10) for tarefa in tarefas]

    def test_envios_http_em_conexoes_distintas_preservam_idempotencia(self):
        url = f"/chat/conversas/{self.conversa.pk}/mensagens/"
        dados = {"conteudo": "Reenvio concorrente", "id_cliente": str(uuid.uuid4())}
        respostas = self.executar_em_paralelo(url, dados)
        self.assertTrue(all(status in (200, 201, 503) for status in respostas), respostas)
        repetida = self.client.post(url, dados, format="json")
        self.assertIn(repetida.status_code, (200, 201))
        self.assertEqual(Mensagem.objects.count(), 1)
        self.assertEqual(self.client.post(url, dados, format="json").status_code, 200)

    def test_criacao_http_concorrente_nao_duplica_conversa(self):
        self.assistente.delete()
        dados = {"destinatario": "assistente"}
        respostas = self.executar_em_paralelo("/chat/conversas/", dados)
        self.assertTrue(all(status in (200, 201, 503) for status in respostas), respostas)
        self.assertIn(self.client.post("/chat/conversas/", dados, format="json").status_code, (200, 201))
        self.assertEqual(Conversa.objects.filter(usuario=self.usuario, destinatario="assistente").count(), 1)


@override_settings(**CONFIG_TESTES)
class ChatWebsocketTests(DadosChatMixin, TransactionTestCase):
    def setUp(self):
        self.preparar_dados()

    @asynccontextmanager
    async def conexoes(self):
        from config.asgi import application
        abertas = []

        async def conectar(token=None, origem=b"http://localhost:5173", caminho="/ws/chat/", aceita=True):
            headers = [(b"origin", origem)] if origem is not None else []
            socket = WebsocketCommunicator(application, caminho, headers=headers)
            abertas.append(socket)
            conectou, _ = await socket.connect()
            self.assertEqual(conectou, aceita)
            if conectou:
                self.assertEqual((await socket.receive_json_from())["type"], "autenticacao.necessaria")
                if token is not None:
                    await socket.send_json_to({"type": "autenticar", "token": token.key})
                    resposta = await socket.receive_json_from()
                    self.assertEqual(resposta["type"], "autenticado")
                    self.assertEqual(resposta["operador"], token.user.is_superuser)
            return socket

        try:
            yield conectar
        finally:
            for socket in abertas:
                await socket.disconnect()

    async def confirmar_envio(self, socket):
        eventos = [await socket.receive_json_from(timeout=2) for _ in range(2)]
        por_tipo = {evento["type"]: evento for evento in eventos}
        self.assertEqual(set(por_tipo), {"mensagem.criada", "mensagem.confirmada"})
        self.assertEqual(por_tipo["mensagem.criada"]["mensagem"]["id"], por_tipo["mensagem.confirmada"]["mensagem"]["id"])
        return por_tipo["mensagem.confirmada"]

    async def test_origem_nao_autorizada_ou_ausente_e_token_na_url_sao_rejeitados(self):
        async with self.conexoes() as conectar:
            await conectar(origem=b"https://site-malicioso.example", aceita=False)
            await conectar(origem=None, aceita=False)
            await conectar(caminho=f"/ws/chat/?token={self.token.key}", aceita=False)

    async def test_nao_pode_enviar_antes_de_autenticar(self):
        async with self.conexoes() as conectar:
            socket = await conectar()
            await socket.send_json_to({"type": "mensagem.enviar", "conteudo": "Tentativa"})
            self.assertEqual((await socket.receive_json_from())["status"], 401)
            self.assertEqual((await socket.receive_output())["code"], 4401)
            self.assertEqual(await Mensagem.objects.acount(), 0)

    async def test_token_invalido_e_usuario_inativo_sao_rejeitados(self):
        async with self.conexoes() as conectar:
            socket = await conectar()
            await socket.send_json_to({"type": "autenticar", "token": "f" * 40})
            self.assertEqual((await socket.receive_json_from())["status"], 401)
            self.assertEqual((await socket.receive_output())["code"], 4401)
            await get_user_model().objects.filter(pk=self.usuario.pk).aupdate(is_active=False)
            inativo = await conectar()
            await inativo.send_json_to({"type": "autenticar", "token": self.token.key})
            self.assertEqual((await inativo.receive_json_from())["status"], 401)

    async def test_token_expirado_nao_autentica_websocket(self):
        await Token.objects.filter(key=self.token.key).aupdate(
            created=timezone.now() - timedelta(days=2)
        )
        async with self.conexoes() as conectar:
            socket = await conectar()
            await socket.send_json_to({"type": "autenticar", "token": self.token.key})
            self.assertEqual((await socket.receive_json_from())["status"], 401)
            self.assertEqual((await socket.receive_output())["code"], 4401)

    @override_settings(AUTH_TOKEN_TTL_SECONDS=0.2)
    async def test_socket_ocioso_fecha_quando_token_expira(self):
        await Token.objects.filter(key=self.token.key).aupdate(created=timezone.now())
        async with self.conexoes() as conectar:
            socket = await conectar(self.token)
            self.assertEqual((await socket.receive_output(timeout=1))["code"], 4401)

    @override_settings(AUTH_TOKEN_TTL_SECONDS=0.6)
    async def test_ping_e_segunda_conexao_nao_prorrogam_prazo_da_sessao(self):
        criado = timezone.now()
        await Token.objects.filter(key=self.token.key).aupdate(created=criado)
        async with self.conexoes() as conectar:
            primeiro = await conectar(self.token)
            await asyncio.sleep(0.2)
            segundo = await conectar(self.token)
            for socket in (primeiro, segundo):
                await socket.send_json_to({"type": "ping"})
                self.assertEqual((await socket.receive_json_from())["type"], "pong")
            self.assertEqual((await primeiro.receive_output(timeout=1))["code"], 4401)
            self.assertEqual((await segundo.receive_output(timeout=0.15))["code"], 4401)
            self.assertEqual((await Token.objects.aget(user=self.usuario)).created, criado)

    @override_settings(AUTH_TOKEN_TTL_SECONDS=0.2)
    async def test_desconectar_cancela_task_de_expiracao_sem_envio_tardio(self):
        from .websocket import ChatConsumer

        tarefas = []
        aguardar = ChatConsumer._aguardar_expiracao

        async def observar(consumer, vencimento):
            tarefas.append(asyncio.current_task())
            await aguardar(consumer, vencimento)

        await Token.objects.filter(key=self.token.key).aupdate(created=timezone.now())
        with patch.object(ChatConsumer, "_aguardar_expiracao", new=observar):
            async with self.conexoes() as conectar:
                socket = await conectar(self.token)
                await asyncio.sleep(0)
                self.assertEqual(len(tarefas), 1)
                self.assertFalse(tarefas[0].done())
                await socket.disconnect()
                self.assertTrue(tarefas[0].cancelled())
                await asyncio.sleep(0.25)
                self.assertTrue(await socket.receive_nothing(timeout=0.01))

    async def test_sessao_vencida_revalida_comando_e_novo_login_permite_reconectar(self):
        async with self.conexoes() as conectar:
            socket = await conectar(self.token)
            await Token.objects.filter(key=self.token.key).aupdate(
                created=timezone.now() - timedelta(days=2)
            )
            await socket.send_json_to({"type": "ping"})
            self.assertEqual((await socket.receive_json_from())["status"], 401)
            self.assertEqual((await socket.receive_output())["code"], 4401)
            self.client.credentials()
            resposta = await database_sync_to_async(self.client.post)(
                "/login/", {"username": self.usuario.username, "password": "SenhaForte!93q8z7"},
                format="json",
            )
            self.assertEqual(resposta.status_code, 200)
            renovado = await Token.objects.select_related("user").aget(user=self.usuario)
            self.assertNotEqual(renovado.key, self.token.key)
            novo_socket = await conectar(renovado)
            await novo_socket.send_json_to({"type": "ping"})
            self.assertEqual((await novo_socket.receive_json_from())["type"], "pong")

    async def test_sessao_vencida_nao_recebe_eventos_privados(self):
        async with self.conexoes() as conectar:
            socket = await conectar(self.token)
            await Token.objects.filter(key=self.token.key).aupdate(
                created=timezone.now() - timedelta(days=2)
            )
            await get_channel_layer().group_send(grupo_usuario(self.usuario.pk), {
                "type": "chat.evento", "dados": {
                    "type": "mensagem.criada", "mensagem": {
                        "conversa_id": str(self.conversa.pk), "conteudo": "privado",
                    },
                },
            })
            self.assertEqual((await socket.receive_output())["code"], 4401)
            self.assertTrue(await socket.receive_nothing(timeout=0.01))

    @override_settings(AUTH_TOKEN_TTL_SECONDS=0.2)
    async def test_operacao_lenta_nao_envia_confirmacao_apos_expiracao(self):
        async def demorar(*args):
            await asyncio.sleep(0.35)
            return {"type": "mensagem.confirmada", "mensagem": {"conteudo": "tardio"}}

        await Token.objects.filter(key=self.token.key).aupdate(created=timezone.now())
        async with self.conexoes() as conectar:
            socket = await conectar(self.token)
            with patch("api.websocket.ChatConsumer._enviar", new=AsyncMock(side_effect=demorar)):
                await socket.send_json_to({
                    "type": "mensagem.enviar", "conversa_id": str(self.conversa.pk),
                    "conteudo": "Mensagem", "id_cliente": str(uuid.uuid4()),
                })
                self.assertEqual((await socket.receive_output(timeout=1))["code"], 4401)
                await asyncio.sleep(0.4)
                self.assertTrue(await socket.receive_nothing(timeout=0.01))

    @override_settings(CHAT_WEBSOCKET_AUTH_TIMEOUT=0.02)
    async def test_conexao_sem_autenticacao_expira(self):
        async with self.conexoes() as conectar:
            socket = await conectar()
            self.assertEqual((await socket.receive_output(timeout=1))["code"], 4401)

    @override_settings(CHAT_WEBSOCKET_AUTH_TIMEOUT=0.02)
    async def test_autenticacao_lenta_nao_reabre_conexao_apos_expirar_prazo(self):
        async def demorar(token):
            await asyncio.sleep(0.08)
            return self.token

        async with self.conexoes() as conectar:
            socket = await conectar()
            with patch("api.websocket.autenticar_token", new=AsyncMock(side_effect=demorar)):
                await socket.send_json_to({"type": "autenticar", "token": self.token.key})
                self.assertEqual((await socket.receive_output(timeout=1))["code"], 4401)
                await asyncio.sleep(0.1)
                self.assertTrue(await socket.receive_nothing(timeout=0.01))

    async def test_envio_entrega_a_todos_superusuarios_sem_vazar_para_outro_visitante(self):
        async with self.conexoes() as conectar:
            usuario = await conectar(self.token)
            operador = await conectar(self.token_operador)
            operador2 = await conectar(self.token_operador2)
            outro = await conectar(self.token_outro)
            chave = str(uuid.uuid4())
            await usuario.send_json_to({
                "type": "mensagem.enviar", "conversa_id": str(self.assistente.pk),
                "conteudo": "Mensagem privada para a caixa do Assistente", "id_cliente": chave,
            })
            confirmada = await self.confirmar_envio(usuario)
            for socket in (operador, operador2):
                evento = await socket.receive_json_from()
                self.assertEqual(evento["type"], "mensagem.criada")
                self.assertEqual(evento["mensagem"]["id"], confirmada["mensagem"]["id"])
            self.assertTrue(await outro.receive_nothing(timeout=0.03))
            self.assertEqual(await Mensagem.objects.acount(), 1)

    async def test_respostas_de_superusuarios_tem_nome_publico_henrique_nas_duas_caixas(self):
        async with self.conexoes() as conectar:
            usuario = await conectar(self.token)
            operador = await conectar(self.token_operador2)
            for conversa in (self.conversa, self.assistente):
                await operador.send_json_to({
                    "type": "mensagem.enviar", "conversa_id": str(conversa.pk),
                    "conteudo": "Resposta do atendimento", "id_cliente": str(uuid.uuid4()),
                })
                await self.confirmar_envio(operador)
                evento = await usuario.receive_json_from()
                self.assertEqual(evento["mensagem"]["remetente"], {"id": None, "nome": "Henrique"})
                self.assertNotIn(self.operador2.username, str(evento))

    async def test_http_publica_mensagem_no_websocket_e_socket_persiste_para_http(self):
        async with self.conexoes() as conectar:
            usuario = await conectar(self.token)
            operador = await conectar(self.token_operador)
            resposta = await database_sync_to_async(self.enviar_http)()
            self.assertEqual(resposta.status_code, 201)
            self.assertEqual((await usuario.receive_json_from())["mensagem"]["id"], resposta.json()["id"])
            self.assertEqual((await operador.receive_json_from())["type"], "mensagem.criada")
            await usuario.send_json_to({
                "type": "mensagem.enviar", "conversa_id": str(self.conversa.pk),
                "conteudo": "Enviado pelo socket", "id_cliente": str(uuid.uuid4()),
            })
            await self.confirmar_envio(usuario)
            await operador.receive_json_from()
            historico = await database_sync_to_async(self.client.get)(f"/chat/conversas/{self.conversa.pk}/mensagens/")
            self.assertEqual(len(historico.json()["results"]), 2)

    async def test_conversa_nova_e_notificada_ao_visitante_e_aos_operadores(self):
        async with self.conexoes() as conectar:
            outro = await conectar(self.token_outro)
            operador = await conectar(self.token_operador)
            self.autorizar(self.token_outro)
            resposta = await database_sync_to_async(self.client.post)(
                "/chat/conversas/", {"destinatario": "assistente"}, format="json"
            )
            self.assertEqual(resposta.status_code, 201)
            for socket in (outro, operador):
                evento = await socket.receive_json_from()
                self.assertEqual(evento["type"], "conversa.criada")
                self.assertEqual(evento["conversa_id"], resposta.json()["id"])

    async def test_socket_nao_le_ou_envia_em_conversa_alheia(self):
        async with self.conexoes() as conectar:
            socket = await conectar(self.token)
            for tipo, dados in (
                ("mensagem.enviar", {"conteudo": "Não autorizado", "id_cliente": str(uuid.uuid4())}),
                ("conversa.ler", {"mensagem_id": 1}),
            ):
                await socket.send_json_to({"type": tipo, "conversa_id": str(self.conversa_outro.pk), **dados})
                self.assertEqual((await socket.receive_json_from())["status"], 404)
            self.assertEqual(await Mensagem.objects.acount(), 0)

    async def test_evento_no_grupo_errado_nao_expoe_conversa_alheia(self):
        async with self.conexoes() as conectar:
            socket = await conectar(self.token)
            await get_channel_layer().group_send(grupo_usuario(self.usuario.pk), {
                "type": "chat.evento",
                "dados": {"type": "mensagem.criada", "mensagem": {
                    "conversa_id": str(self.conversa_outro.pk), "conteudo": "privado",
                }},
            })
            self.assertTrue(await socket.receive_nothing(timeout=0.03))
            await socket.send_json_to({"type": "ping"})
            self.assertEqual((await socket.receive_json_from())["type"], "pong")

    async def test_reenvio_websocket_nao_duplica_nem_publica_de_novo(self):
        async with self.conexoes() as conectar:
            socket = await conectar(self.token)
            dados = {
                "type": "mensagem.enviar", "conversa_id": str(self.conversa.pk),
                "conteudo": "Uma vez", "id_cliente": str(uuid.uuid4()),
            }
            await socket.send_json_to(dados)
            primeira = await self.confirmar_envio(socket)
            await socket.send_json_to(dados)
            repetida = await socket.receive_json_from()
            self.assertTrue(repetida["repetida"])
            self.assertEqual(primeira["mensagem"]["id"], repetida["mensagem"]["id"])
            self.assertTrue(await socket.receive_nothing(timeout=0.03))
            await socket.send_json_to({**dados, "conteudo": "Mudou"})
            erro = await socket.receive_json_from()
            self.assertEqual(erro["status"], 409)
            self.assertEqual(erro["id_cliente"], dados["id_cliente"])
            self.assertEqual(erro["conversa_id"], dados["conversa_id"])
            self.assertEqual(await Mensagem.objects.acount(), 1)

    async def test_envios_simultaneos_de_duas_conexoes_nao_duplicam_mensagem(self):
        async with self.conexoes() as conectar:
            primeiro = await conectar(self.token)
            segundo = await conectar(self.token)
            dados = {
                "type": "mensagem.enviar", "conversa_id": str(self.conversa.pk),
                "conteudo": "Reenvio simultâneo", "id_cliente": str(uuid.uuid4()),
            }
            await asyncio.gather(primeiro.send_json_to(dados), segundo.send_json_to(dados))
            respostas = await asyncio.gather(
                self.confirmar_envio(primeiro), self.confirmar_envio(segundo)
            )
            self.assertEqual(respostas[0]["mensagem"]["id"], respostas[1]["mensagem"]["id"])
            self.assertEqual(sorted(r["repetida"] for r in respostas), [False, True])
            self.assertEqual(await Mensagem.objects.acount(), 1)

    async def test_transacao_revertida_nao_salva_ou_publica_mensagem(self):
        @database_sync_to_async
        def reverter():
            with transaction.atomic():
                enviar_mensagem(self.usuario, self.conversa.pk, {
                    "conteudo": "Deve ser revertida", "id_cliente": str(uuid.uuid4()),
                })
                transaction.set_rollback(True)

        async with self.conexoes() as conectar:
            usuario = await conectar(self.token)
            operador = await conectar(self.token_operador)
            await reverter()
            self.assertEqual(await Mensagem.objects.acount(), 0)
            self.assertTrue(await usuario.receive_nothing(timeout=0.03))
            self.assertTrue(await operador.receive_nothing(timeout=0.03))

    async def test_autor_forjado_e_payloads_invalidos_nao_salvam_mensagens(self):
        async with self.conexoes() as conectar:
            socket = await conectar(self.token)
            dados = {
                "type": "mensagem.enviar", "conversa_id": str(self.conversa.pk),
                "conteudo": "Texto", "id_cliente": str(uuid.uuid4()),
            }
            for alteracao in ({"origem": "assistente"}, {"conteudo": " "}, {"conversa_id": "invalido"}):
                await socket.send_json_to({**dados, **alteracao})
                self.assertEqual((await socket.receive_json_from())["status"], 400)
            for invalido in ([], {"type": []}, {"type": "desconhecido"}):
                await socket.send_json_to(invalido)
                self.assertEqual((await socket.receive_json_from())["status"], 400)
            self.assertEqual(await Mensagem.objects.acount(), 0)

    async def test_json_invalido_nao_derruba_socket_autenticado(self):
        async with self.conexoes() as conectar:
            socket = await conectar(self.token)
            await socket.send_to(text_data="{invalido")
            self.assertEqual((await socket.receive_json_from())["status"], 400)
            await socket.send_json_to({"type": "ping"})
            self.assertEqual((await socket.receive_json_from())["type"], "pong")

    async def test_payload_excessivo_e_binario_encerram_conexao(self):
        async with self.conexoes() as conectar:
            grande = await conectar(self.token)
            await grande.send_to(text_data="x" * 32769)
            self.assertEqual((await grande.receive_output())["code"], 1009)
            binario = await conectar(self.token)
            await binario.send_to(bytes_data=b"nao suportado")
            self.assertEqual((await binario.receive_output())["code"], 1003)

    async def test_excesso_de_conexoes_e_frames_encerra_acesso(self):
        with patch("api.websocket.WebsocketThrottle.get_rate", return_value="1/min"):
            async with self.conexoes() as conectar:
                socket = await conectar(self.token)
                await conectar(aceita=False)
                for _ in range(119):
                    await socket.send_json_to({"type": "ping"})
                    self.assertEqual((await socket.receive_json_from())["type"], "pong")
                await socket.send_json_to({"type": "ping"})
                self.assertEqual((await socket.receive_output())["code"], 4429)

    async def test_falha_de_transporte_durante_autenticacao_encerra_sem_expor_detalhes(self):
        async with self.conexoes() as conectar:
            socket = await conectar()
            with patch.object(get_channel_layer(), "group_add", new=AsyncMock(side_effect=ConnectionError("detalhe interno"))):
                await socket.send_json_to({"type": "autenticar", "token": self.token.key})
                erro = await socket.receive_json_from()
                self.assertEqual(erro["status"], 503)
                self.assertNotIn("detalhe interno", str(erro))
                self.assertEqual((await socket.receive_output())["code"], 1013)

    async def test_limite_de_envio_e_compartilhado_entre_http_e_websocket(self):
        with patch.object(MensagemThrottle, "get_rate", return_value="1/min"):
            async with self.conexoes() as conectar:
                resposta = await database_sync_to_async(self.enviar_http)()
                self.assertEqual(resposta.status_code, 201)
                socket = await conectar(self.token)
                await socket.send_json_to({
                    "type": "mensagem.enviar", "conversa_id": str(self.conversa.pk),
                    "conteudo": "Acima do limite", "id_cliente": str(uuid.uuid4()),
                })
                erro = await socket.receive_json_from()
                self.assertEqual(erro["status"], 429)
                self.assertGreater(erro["tente_novamente_em"], 0)
                self.assertEqual(await Mensagem.objects.acount(), 1)

    async def test_leitura_e_confirmada_e_publicada_para_os_dois_lados(self):
        resposta = await database_sync_to_async(self.enviar_http)()
        async with self.conexoes() as conectar:
            usuario = await conectar(self.token)
            operador = await conectar(self.token_operador)
            await operador.send_json_to({
                "type": "conversa.ler", "conversa_id": str(self.conversa.pk),
                "mensagem_id": resposta.json()["id"],
            })
            eventos = [await operador.receive_json_from() for _ in range(2)]
            self.assertEqual({e["type"] for e in eventos}, {"conversa.lida", "leitura.confirmada"})
            recebida = await usuario.receive_json_from()
            self.assertEqual(recebida["type"], "conversa.lida")
            self.assertEqual(recebida["por"], "henrique")

    async def test_logout_fecha_sockets_e_revoga_token(self):
        async with self.conexoes() as conectar:
            socket = await conectar(self.token)
            resposta = await database_sync_to_async(self.client.post)("/logout/")
            self.assertEqual(resposta.status_code, 204)
            self.assertEqual((await socket.receive_output())["code"], 4401)
            self.assertFalse(await Token.objects.filter(pk=self.token.pk).aexists())

    async def test_revogacao_e_desativacao_sao_revalidadas_no_socket_aberto(self):
        async with self.conexoes() as conectar:
            socket = await conectar(self.token)
            await Token.objects.filter(pk=self.token.pk).adelete()
            await socket.send_json_to({"type": "ping"})
            self.assertEqual((await socket.receive_json_from())["status"], 401)
            self.assertEqual((await socket.receive_output())["code"], 4401)
            outro = await conectar(self.token_outro)
            await get_user_model().objects.filter(pk=self.outro.pk).aupdate(is_active=False)
            await get_channel_layer().group_send(grupo_usuario(self.outro.pk), {
                "type": "chat.evento", "dados": {"type": "nao_deve_chegar"},
            })
            self.assertEqual((await outro.receive_output())["code"], 4401)

    async def test_remover_superuser_fecha_socket_antes_de_entregar_dados_privados(self):
        async with self.conexoes() as conectar:
            operador = await conectar(self.token_operador)
            await get_user_model().objects.filter(pk=self.operador.pk).aupdate(is_superuser=False)
            await get_channel_layer().group_send(grupo_usuario(self.operador.pk), {
                "type": "chat.evento", "dados": {"type": "nao_deve_chegar", "conteudo": "privado"},
            })
            self.assertEqual((await operador.receive_output())["code"], 4403)
