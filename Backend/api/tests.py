from datetime import timedelta
from time import time
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.core.management import call_command
from django.test import override_settings
from django.utils import timezone
from rest_framework.authtoken.models import Token
from rest_framework.test import APITestCase


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
