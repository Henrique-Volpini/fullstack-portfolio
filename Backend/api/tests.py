import asyncio
import uuid
from base64 import b64encode
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from datetime import timedelta
from threading import Barrier
from time import time
from unittest.mock import AsyncMock, patch
from urllib.parse import urlsplit

from channels.db import database_sync_to_async
from channels.layers import get_channel_layer
from channels.testing import WebsocketCommunicator
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.core.management import call_command
from django.db import IntegrityError, close_old_connections, transaction
from django.test import TransactionTestCase, override_settings
from django.utils import timezone
from rest_framework.authtoken.models import Token
from rest_framework.test import APIClient, APITestCase

from .models import Conversa, Mensagem
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

    def test_token_existente_nao_e_expirado_ou_substituido(self):
        token = Token.objects.create(user=self.usuario)
        Token.objects.filter(pk=token.pk).update(created=timezone.now() - timedelta(days=2))
        resposta = self.login()
        self.assertEqual(resposta.status_code, 200)
        self.assertEqual(resposta.json()["token"], token.key)


CONFIG_TESTES = {
    "PASSWORD_HASHERS": ["django.contrib.auth.hashers.MD5PasswordHasher"],
    "CACHES": {"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}},
    "CHANNEL_LAYERS": {"default": {"BACKEND": "channels.layers.InMemoryChannelLayer"}},
}


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

    @override_settings(CHAT_WEBSOCKET_AUTH_TIMEOUT=0.02)
    async def test_conexao_sem_autenticacao_expira(self):
        async with self.conexoes() as conectar:
            socket = await conectar()
            self.assertEqual((await socket.receive_output(timeout=1))["code"], 4401)

    @override_settings(CHAT_WEBSOCKET_AUTH_TIMEOUT=0.02)
    async def test_autenticacao_lenta_nao_reabre_conexao_apos_expirar_prazo(self):
        async def demorar(token):
            await asyncio.sleep(0.08)
            return self.usuario

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
