from datetime import datetime, timedelta

from django.conf import settings
from django.db import DatabaseError, IntegrityError, transaction
from django.utils import timezone
from rest_framework.authentication import TokenAuthentication
from rest_framework.authtoken.models import Token
from rest_framework.exceptions import APIException, AuthenticationFailed


# Representa uma falha temporária no serviço de autenticação.
class SessaoIndisponivel(APIException):
    status_code = 503
    default_detail = "A autenticação está temporariamente indisponível. Tente novamente."
    default_code = "sessao_indisponivel"


# Calcula a data de expiração de um token.
def expira_em(token: Token) -> datetime:
    return token.created + timedelta(seconds=settings.AUTH_TOKEN_TTL_SECONDS)


# Valida o token e verifica a atividade da conta e o prazo da sessão.
def validar_token(chave: str) -> Token:
    if not isinstance(chave, str) or not chave:
        raise AuthenticationFailed("Token inválido.")
    try:
        token = Token.objects.select_related("user").get(key=chave)
    except Token.DoesNotExist:
        raise AuthenticationFailed("Token inválido.") from None
    except DatabaseError:
        raise SessaoIndisponivel() from None

    if not token.user.is_active:
        raise AuthenticationFailed("Esta conta está desativada.")
    if timezone.now() >= expira_em(token):
        raise AuthenticationFailed(
            "Sua sessão expirou. Faça login novamente.", code="sessao_expirada"
        )
    return token


# Autentica requisições com tokens sujeitos a expiração.
class TokenExpiravelAuthentication(TokenAuthentication):
    # Retorna o usuário e o token após validar as credenciais.
    def authenticate_credentials(self, key):
        token = validar_token(key)
        return token.user, token


# Obtém um token válido e renova os expirados com controle de concorrência.
def obter_token_acesso(usuario) -> Token:
    if not usuario.is_active:
        raise AuthenticationFailed("Esta conta está desativada.")

    for _ in range(3):
        try:
            token, _ = Token.objects.get_or_create(user=usuario)
            agora = timezone.now()
            if agora < expira_em(token):
                return token

            nova_chave = Token.generate_key()
            with transaction.atomic():
                alterados = Token.objects.filter(
                    key=token.key, user_id=usuario.pk
                ).update(key=nova_chave, created=agora)
            if alterados:
                token.key = nova_chave
                token.created = agora
                return token
        except IntegrityError:
            continue
        except DatabaseError:
            raise SessaoIndisponivel() from None

    raise SessaoIndisponivel()
