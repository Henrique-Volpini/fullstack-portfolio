import json
from base64 import urlsafe_b64decode
from datetime import UTC, datetime
from hashlib import sha256
from threading import Lock
from time import monotonic, time
from types import SimpleNamespace
from uuid import uuid4

from django.conf import settings
from django.contrib.auth import get_user_model
from django.db import DatabaseError, transaction
from django.utils import timezone
from django.utils.http import parse_http_date_safe
from google.auth import crypt as google_crypt
from google.auth.exceptions import GoogleAuthError, TransportError
from google.auth.transport.requests import Request as GoogleRequest
from google.oauth2 import id_token
from requests import Session
from requests.structures import CaseInsensitiveDict
from requests.utils import parse_dict_header, parse_list_header
from rest_framework import serializers
from rest_framework.exceptions import APIException, AuthenticationFailed
from rest_framework.parsers import JSONParser
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from ..authentication import obter_token_acesso
from ..models import ContaGoogle, CredencialGoogleUtilizada
from ..serializers import CadastroUsuarioSerializer, LoginGoogleSerializer


# Representa a indisponibilidade temporária do login Google.
class LoginGoogleIndisponivel(APIException):
    status_code = 503
    default_detail = "O login com Google está temporariamente indisponível. Tente novamente."
    default_code = "login_google_indisponivel"


GOOGLE_CERTIFICADOS_URL = "https://www.googleapis.com/oauth2/v1/certs"
_cache_certificados_google = None
_trava_certificados_google = Lock()


# Calcula o prazo restante de validade dos certificados.
def _validade_cache_google(headers, *, agora, duracao):
    headers = CaseInsensitiveDict(headers)
    politica = headers.get("Cache-Control", "")
    controle = {
        chave.lower(): valor
        for chave, valor in parse_dict_header(politica).items()
    }
    if len(parse_list_header(politica)) != len(controle) or "no-store" in controle or "no-cache" in controle:
        return 0
    idade = headers.get("Age", "0")
    if not idade.isascii() or not idade.isdigit() or len(idade) > 10:
        return 0
    data = parse_http_date_safe(headers["Date"]) if "Date" in headers else None
    if "Date" in headers and data is None:
        return 0
    if "max-age" in controle:
        prazo = controle["max-age"]
        if prazo is None or not prazo.isascii() or not prazo.isdigit() or len(prazo) > 10:
            return 0
        prazo = int(prazo)
    else:
        vencimento = parse_http_date_safe(headers.get("Expires", ""))
        if vencimento is None:
            return 0
        prazo = vencimento - (data if data is not None else agora)
    idade = max(int(idade), max(0, agora - data) if data is not None else 0)
    return max(0, prazo - idade - duracao)


# Obtém os certificados Google e reutiliza o cache válido.
def _requisitar_certificados_google(url, method="GET"):
    global _cache_certificados_google
    if url != GOOGLE_CERTIFICADOS_URL or method != "GET":
        raise TransportError("Consulta de certificados inválida.")
    entrada = _cache_certificados_google
    if entrada is not None and monotonic() < entrada[1]:
        return SimpleNamespace(status=200, data=entrada[0])
    if not _trava_certificados_google.acquire(blocking=False):
        raise TransportError("Consulta de certificados em andamento.")
    try:
        entrada = _cache_certificados_google
        if entrada is not None and monotonic() < entrada[1]:
            return SimpleNamespace(status=200, data=entrada[0])
        _cache_certificados_google = None
        inicio = monotonic()
        with Session() as sessao:
            resposta = GoogleRequest(session=sessao)(
                url, method="GET", timeout=5, allow_redirects=False,
            )
        if resposta.status != 200:
            raise TransportError("Certificados indisponíveis.")
        dados = bytes(resposta.data)
        certificados = json.loads(dados.decode("utf-8"))
        if not isinstance(certificados, dict) or not certificados:
            raise ValueError
        for chave, certificado in certificados.items():
            if not isinstance(chave, str) or not chave or not isinstance(certificado, str):
                raise ValueError
            google_crypt.RSAVerifier.from_string(certificado)
        fim = monotonic()
        prazo = _validade_cache_google(resposta.headers, agora=time(), duracao=fim - inicio)
        if prazo > 0:
            _cache_certificados_google = (dados, fim + prazo)
        return SimpleNamespace(status=200, data=dados)
    except (ValueError, TypeError, RecursionError):
        raise TransportError("Resposta de certificados inválida.") from None
    finally:
        _trava_certificados_google.release()


# Autentica contas com credenciais verificadas do Google.
class LoginGoogleView(APIView):
    permission_classes = (AllowAny,)
    authentication_classes = ()
    parser_classes = (JSONParser,)
    throttle_scope = "login"
    http_method_names = ("post", "options")

    # Informa o esquema de autenticação nas respostas.
    def get_authenticate_header(self, request):
        return "Token"

    # Valida o login Google e retorna o token local.
    def post(self, request):
        validacao = LoginGoogleSerializer(data=request.data)
        validacao.is_valid(raise_exception=True)
        if not settings.GOOGLE_CLIENT_ID:
            raise LoginGoogleIndisponivel()

        try:
            perfil = id_token.verify_oauth2_token(
                validacao.validated_data["credential"],
                _requisitar_certificados_google,
                audience=settings.GOOGLE_CLIENT_ID,
            )
        except TransportError:
            raise LoginGoogleIndisponivel() from None
        except (ValueError, GoogleAuthError, KeyError, TypeError):
            raise AuthenticationFailed("Credencial do Google inválida ou expirada.") from None

        sub = perfil.get("sub")
        email = perfil.get("email")
        nome = perfil.get("given_name", "")
        sobrenome = perfil.get("family_name", "")
        expiracao = perfil.get("exp")
        if (
            not isinstance(sub, str) or not sub.strip() or len(sub) > 255
            or perfil.get("email_verified") is not True
            or not isinstance(email, str)
            or not isinstance(nome, str) or not isinstance(sobrenome, str)
            or not isinstance(expiracao, int) or isinstance(expiracao, bool)
        ):
            raise AuthenticationFailed("Credencial do Google inválida ou expirada.")
        try:
            email = serializers.EmailField(max_length=254).run_validation(email)
            expira_em = datetime.fromtimestamp(expiracao, UTC)
            trecho_assinado, assinatura = validacao.validated_data["credential"].rsplit(".", 1)
            assinatura = urlsafe_b64decode(assinatura + "=" * (-len(assinatura) % 4))
        except (serializers.ValidationError, ValueError, OverflowError, OSError):
            raise AuthenticationFailed("Credencial do Google inválida ou expirada.") from None

        # Assinaturas com bits de preenchimento diferentes representam a mesma credencial.
        impressao = sha256(trecho_assinado.encode("ascii") + b"." + assinatura).hexdigest()
        try:
            with transaction.atomic():
                # A biblioteca aceita o token até o fim do segundo informado em exp.
                agora = timezone.now().replace(microsecond=0)
                if expira_em < agora:
                    raise AuthenticationFailed("Credencial do Google inválida ou expirada.")
                CredencialGoogleUtilizada.objects.filter(expira_em__lt=agora).delete()
                _, criada = CredencialGoogleUtilizada.objects.get_or_create(
                    impressao=impressao, defaults={"expira_em": expira_em},
                )
                if not criada:
                    raise AuthenticationFailed(
                        "Esta credencial do Google já foi utilizada. Entre novamente pelo Google."
                    )
                conta, _ = ContaGoogle.objects.select_related("usuario").get_or_create(
                    sub=sub,
                    defaults={
                        "usuario": lambda: get_user_model().objects.create_user(
                            username=f"google_{uuid4().hex}",
                            password=None,
                            email=email,
                            first_name=nome[:150],
                            last_name=sobrenome[:150],
                        ),
                    },
                )

                usuario = conta.usuario
                token_acesso = obter_token_acesso(usuario)
        except DatabaseError:
            raise LoginGoogleIndisponivel() from None

        return Response({
            "token": token_acesso.key,
            "usuario": CadastroUsuarioSerializer(usuario).data,
        })
