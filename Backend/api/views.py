import hashlib
import logging
from functools import partial
from types import SimpleNamespace
from uuid import uuid4

from asgiref.sync import async_to_sync
from axes.utils import reset
from channels.layers import get_channel_layer
from django.conf import settings
from django.contrib.auth import authenticate, get_user_model
from django.db import DatabaseError, IntegrityError, transaction
from django.db.models import Count, F, Prefetch, Q
from django.http import JsonResponse
from django.shortcuts import get_object_or_404
from google.auth.exceptions import GoogleAuthError, TransportError
from google.auth.transport.requests import Request as GoogleRequest
from google.oauth2 import id_token
from requests import Session
from rest_framework import serializers, status
from rest_framework.authtoken.models import Token
from rest_framework.exceptions import (
    APIException, AuthenticationFailed, NotFound, PermissionDenied, Throttled,
)
from rest_framework.generics import CreateAPIView
from rest_framework.pagination import CursorPagination, PageNumberPagination
from rest_framework.parsers import JSONParser
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle, SimpleRateThrottle
from rest_framework.views import APIView

from .authentication import obter_token_acesso
from .models import ContaGoogle, Conversa, Mensagem
from .serializers import (
    CadastroUsuarioSerializer, ConversaSerializer, CriarConversaSerializer,
    EnviarMensagemSerializer, LoginGoogleSerializer, LoginUsuarioSerializer, MarcarLeituraSerializer,
    MensagemSerializer, UsuarioChatSerializer,
)


logger = logging.getLogger(__name__)


def resposta_bloqueio(request, response=None, credentials=None):
    return JsonResponse(
        {"detail": "Login temporariamente bloqueado. Aguarde o desbloqueio automático."},
        status=status.HTTP_429_TOO_MANY_REQUESTS,
    )


class CadastroUsuarioView(CreateAPIView):

    serializer_class = CadastroUsuarioSerializer
    permission_classes = (AllowAny,)
    authentication_classes = ()
    throttle_classes = (ScopedRateThrottle,)
    throttle_scope = "cadastro"
    http_method_names = ("post", "options")


class LoginUsuarioView(APIView):
    permission_classes = (AllowAny,)
    authentication_classes = ()
    throttle_classes = (ScopedRateThrottle,)
    throttle_scope = "login"
    http_method_names = ("post", "options")

    def post(self, request):
        validacao_login = LoginUsuarioSerializer(data=request.data)
        validacao_login.is_valid(raise_exception=True)

        usuario = authenticate(
            request=request._request,
            username=validacao_login.validated_data["username"],
            password=validacao_login.validated_data["password"],
        )

        if usuario is None:
            return Response(
                {"erro": "Usuário ou senha incorretos."},
                status=status.HTTP_401_UNAUTHORIZED,
                headers={"WWW-Authenticate": "Token"},
            )

        token_acesso = obter_token_acesso(usuario)
        reset(username=usuario.get_username())

        return Response(
            {
                "token": token_acesso.key,
                "usuario": CadastroUsuarioSerializer(usuario).data,
            },
            status=status.HTTP_200_OK,
        )


class LoginGoogleIndisponivel(APIException):
    status_code = 503
    default_detail = "O login com Google está temporariamente indisponível. Tente novamente."
    default_code = "login_google_indisponivel"


class LoginGoogleView(APIView):
    permission_classes = (AllowAny,)
    authentication_classes = ()
    parser_classes = (JSONParser,)
    throttle_classes = (ScopedRateThrottle,)
    throttle_scope = "login"
    http_method_names = ("post", "options")

    def get_authenticate_header(self, request):
        return "Token"

    def post(self, request):
        validacao = LoginGoogleSerializer(data=request.data)
        validacao.is_valid(raise_exception=True)
        if not settings.GOOGLE_CLIENT_ID:
            raise LoginGoogleIndisponivel()

        try:
            with Session() as sessao:
                perfil = id_token.verify_oauth2_token(
                    validacao.validated_data["credential"],
                    partial(GoogleRequest(session=sessao), timeout=5),
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
        if (
            not isinstance(sub, str) or not sub.strip() or len(sub) > 255
            or perfil.get("email_verified") is not True
            or not isinstance(email, str)
            or not isinstance(nome, str) or not isinstance(sobrenome, str)
        ):
            raise AuthenticationFailed("Credencial do Google inválida ou expirada.")
        try:
            email = serializers.EmailField(max_length=254).run_validation(email)
        except serializers.ValidationError:
            raise AuthenticationFailed("Credencial do Google inválida ou expirada.") from None

        try:
            conta = ContaGoogle.objects.select_related("usuario").filter(sub=sub).first()
            if conta is None:
                try:
                    with transaction.atomic():
                        usuario = get_user_model().objects.create_user(
                            username=f"google_{uuid4().hex}",
                            password=None,
                            email=email,
                            first_name=nome[:150],
                            last_name=sobrenome[:150],
                        )
                        conta = ContaGoogle.objects.create(usuario=usuario, sub=sub)
                except IntegrityError:
                    # Outro acesso pode ter criado o mesmo vínculo durante a transação.
                    conta = ContaGoogle.objects.select_related("usuario").filter(sub=sub).first()
                    if conta is None:
                        raise

            usuario = conta.usuario
            if not usuario.is_active:
                raise AuthenticationFailed("Esta conta está desativada.")
            token_acesso = obter_token_acesso(usuario)
        except DatabaseError:
            raise LoginGoogleIndisponivel() from None

        return Response({
            "token": token_acesso.key,
            "usuario": CadastroUsuarioSerializer(usuario).data,
        })


class ChatIndisponivel(APIException):
    status_code = 503
    default_detail = "O chat está temporariamente indisponível. Tente novamente."
    default_code = "chat_indisponivel"


class ConflitoMensagem(APIException):
    status_code = 409
    default_detail = "Este id_cliente já foi utilizado em outra mensagem."
    default_code = "conflito_mensagem"


class MensagemThrottle(SimpleRateThrottle):
    scope = "chat_mensagem"

    def get_cache_key(self, request, view):
        return self.cache_format % {"scope": self.scope, "ident": request.user.pk}


class WebsocketThrottle(SimpleRateThrottle):
    scope = "chat_websocket"

    def get_cache_key(self, request, view):
        return self.cache_format % {"scope": self.scope, "ident": request.META["REMOTE_ADDR"]}


def eh_operador(usuario):
    return bool(
        usuario.is_authenticated
        and usuario.is_active
        and usuario.is_superuser
    )


def obter_operadores():
    usuarios = tuple(get_user_model().objects.filter(
        is_active=True, is_superuser=True
    ).values_list("pk", flat=True))
    if not usuarios:
        raise ChatIndisponivel("O responsável pelo chat ainda não está disponível.")
    return usuarios


def grupo_usuario(usuario_id):
    return f"chat.usuario.{usuario_id}"


def assinatura_token(token):
    return hashlib.sha256(token.encode()).hexdigest()


def publicar_evento(usuario_ids, dados, tipo="chat.evento"):
    try:
        camada = get_channel_layer()
    except Exception:
        logger.warning("Não foi possível publicar um evento do chat; consulte o histórico.")
        return
    for usuario_id in set(usuario_ids):
        try:
            async_to_sync(camada.group_send)(
                grupo_usuario(usuario_id), {"type": tipo, "dados": dados}
            )
        except Exception:
            logger.warning("Não foi possível publicar um evento do chat; consulte o histórico.")


def conversas_permitidas(usuario):
    if not usuario.is_authenticated or not usuario.is_active:
        raise AuthenticationFailed()
    conversas = Conversa.objects.all()
    if not eh_operador(usuario):
        conversas = conversas.filter(usuario=usuario)
    return conversas


def consultar_conversas(usuario):
    if eh_operador(usuario):
        recebidas = Q(mensagens__origem=Mensagem.Origem.USUARIO)
        marcador = "ultima_lida_henrique"
    else:
        recebidas = ~Q(mensagens__origem=Mensagem.Origem.USUARIO)
        marcador = "ultima_lida_usuario"
    return (
        conversas_permitidas(usuario)
        .select_related("usuario")
        .annotate(nao_lidas=Count(
            "mensagens", filter=recebidas & Q(mensagens__id__gt=F(marcador))
        ))
        .prefetch_related(Prefetch(
            "mensagens",
            queryset=Mensagem.objects.select_related("remetente").order_by("-id")[:1],
            to_attr="ultimas_mensagens",
        ))
        .order_by("-atualizada_em", "-id")
    )


def obter_conversa(usuario, conversa_id):
    return get_object_or_404(conversas_permitidas(usuario).select_related("usuario"), pk=conversa_id)


def criar_conversa(usuario, dados):
    if eh_operador(usuario):
        raise PermissionDenied("Responda pelas conversas recebidas dos usuários.")
    validacao = CriarConversaSerializer(data=dados)
    validacao.is_valid(raise_exception=True)
    operadores = obter_operadores()
    conversa, criada = Conversa.objects.get_or_create(
        usuario=usuario, destinatario=validacao.validated_data["destinatario"]
    )
    if criada:
        evento = {
            "type": "conversa.criada",
            "conversa_id": str(conversa.pk),
            "usuario": UsuarioChatSerializer(usuario).data,
            "destinatario": conversa.destinatario,
        }
        transaction.on_commit(partial(publicar_evento, (usuario.pk, *operadores), evento))
    return conversa, criada


def _verificar_repetida(mensagem, remetente, dados):
    remetente_id = remetente.pk if remetente is not None else None
    if mensagem.conteudo != dados["conteudo"] or mensagem.remetente_id != remetente_id:
        raise ConflitoMensagem()
    return mensagem, False


def _persistir_mensagem(conversa, remetente, origem, dados):
    anteriores = Mensagem.objects.select_related("remetente").filter(
        conversa=conversa, origem=origem, id_cliente=dados["id_cliente"]
    )
    anterior = anteriores.first()
    if anterior is not None:
        return _verificar_repetida(anterior, remetente, dados)

    operadores = obter_operadores()
    if remetente is not None:
        limite = MensagemThrottle()
        if not limite.allow_request(SimpleNamespace(user=remetente), None):
            raise Throttled(wait=limite.wait())

    try:
        with transaction.atomic():
            mensagem = Mensagem.objects.create(
                conversa=conversa, remetente=remetente, origem=origem, **dados
            )
            Conversa.objects.filter(
                pk=conversa.pk, atualizada_em__lt=mensagem.criada_em
            ).update(atualizada_em=mensagem.criada_em)
            evento = {"type": "mensagem.criada", "mensagem": MensagemSerializer(mensagem).data}
            transaction.on_commit(partial(
                publicar_evento, (conversa.usuario_id, *operadores), evento
            ))
    except IntegrityError:
        anterior = anteriores.first()
        if anterior is not None:
            return _verificar_repetida(anterior, remetente, dados)
        raise
    return mensagem, True


def enviar_mensagem(usuario, conversa_id, dados):
    conversa = obter_conversa(usuario, conversa_id)
    validacao = EnviarMensagemSerializer(data=dados)
    validacao.is_valid(raise_exception=True)
    origem = Mensagem.Origem.HENRIQUE if eh_operador(usuario) else Mensagem.Origem.USUARIO
    return _persistir_mensagem(conversa, usuario, origem, validacao.validated_data)


def registrar_resposta_assistente(conversa_id, dados):
    conversa = get_object_or_404(Conversa, pk=conversa_id, destinatario=Conversa.Destinatario.ASSISTENTE)
    validacao = EnviarMensagemSerializer(data=dados)
    validacao.is_valid(raise_exception=True)
    return _persistir_mensagem(conversa, None, Mensagem.Origem.ASSISTENTE, validacao.validated_data)


def marcar_leitura(usuario, conversa_id, dados):
    conversa = obter_conversa(usuario, conversa_id)
    validacao = MarcarLeituraSerializer(data=dados)
    validacao.is_valid(raise_exception=True)
    mensagem_id = validacao.validated_data["mensagem_id"]
    if not conversa.mensagens.filter(pk=mensagem_id).exists():
        raise NotFound("Mensagem não encontrada nesta conversa.")
    operadores = obter_operadores()
    operador = eh_operador(usuario)
    coluna = "ultima_lida_henrique" if operador else "ultima_lida_usuario"
    alteradas = Conversa.objects.filter(
        pk=conversa.pk, **{f"{coluna}__lt": mensagem_id}
    ).update(**{coluna: mensagem_id})
    marcador = Conversa.objects.values_list(coluna, flat=True).get(pk=conversa.pk)
    evento = {
        "type": "conversa.lida", "conversa_id": str(conversa.pk),
        "por": "henrique" if operador else "usuario", "mensagem_id": marcador,
    }
    if alteradas:
        transaction.on_commit(partial(
            publicar_evento, (conversa.usuario_id, *operadores), evento
        ))
    return evento


class ConversasPagination(PageNumberPagination):
    page_size = 20
    page_size_query_param = "tamanho"
    max_page_size = 100


class MensagensPagination(CursorPagination):
    page_size = 50
    page_size_query_param = "tamanho"
    max_page_size = 100
    ordering = "-id"

    def decode_cursor(self, request):
        cursor = super().decode_cursor(request)
        if cursor is not None and cursor.position is not None:
            campo = serializers.IntegerField(min_value=1, max_value=9223372036854775807)
            try:
                posicao = campo.run_validation(cursor.position)
            except serializers.ValidationError as erro:
                raise NotFound(self.invalid_cursor_message) from erro
            cursor = cursor._replace(position=str(posicao))
        return cursor

    def get_ordering(self, request, queryset, view):
        return ("id",) if "apos_id" in request.query_params else ("-id",)


class ChatAPIView(APIView):
    throttle_classes = (ScopedRateThrottle,)
    throttle_scope = "chat"
    http_method_names = ("get", "post", "head", "options")

    def handle_exception(self, exc):
        if isinstance(exc, DatabaseError):
            exc = ChatIndisponivel()
        return super().handle_exception(exc)


class ChatInicioView(ChatAPIView):
    http_method_names = ("get", "head", "options")

    def get(self, request):
        return Response({
            "usuario": UsuarioChatSerializer(request.user).data,
            "operador": eh_operador(request.user),
            "destinatarios": [
                {"id": valor, "nome": nome}
                for valor, nome in Conversa.Destinatario.choices
            ],
            "assistente_ia_ativo": False,
            "websocket_path": "/ws/chat/",
        })


class ConversasView(ChatAPIView):
    def get(self, request):
        conversas = consultar_conversas(request.user)
        destinatario = request.query_params.get("destinatario")
        if destinatario is not None:
            campo = serializers.ChoiceField(choices=Conversa.Destinatario.choices)
            conversas = conversas.filter(destinatario=campo.run_validation(destinatario))
        paginacao = ConversasPagination()
        pagina = paginacao.paginate_queryset(conversas, request, view=self)
        return paginacao.get_paginated_response(ConversaSerializer(pagina, many=True).data)

    def post(self, request):
        conversa, criada = criar_conversa(request.user, request.data)
        detalhada = consultar_conversas(request.user).get(pk=conversa.pk)
        return Response(
            ConversaSerializer(detalhada).data,
            status=status.HTTP_201_CREATED if criada else status.HTTP_200_OK,
        )


class ConversaDetalheView(ChatAPIView):
    http_method_names = ("get", "head", "options")

    def get(self, request, conversa_id):
        conversa = get_object_or_404(consultar_conversas(request.user), pk=conversa_id)
        return Response(ConversaSerializer(conversa).data)


class MensagensView(ChatAPIView):
    def get(self, request, conversa_id):
        conversa = obter_conversa(request.user, conversa_id)
        mensagens = conversa.mensagens.select_related("remetente").all()
        if "apos_id" in request.query_params:
            campo = serializers.IntegerField(min_value=0, max_value=9223372036854775807)
            mensagens = mensagens.filter(id__gt=campo.run_validation(request.query_params["apos_id"]))
        paginacao = MensagensPagination()
        pagina = paginacao.paginate_queryset(mensagens, request, view=self)
        return paginacao.get_paginated_response(MensagemSerializer(pagina, many=True).data)

    def post(self, request, conversa_id):
        mensagem, criada = enviar_mensagem(request.user, conversa_id, request.data)
        return Response(
            MensagemSerializer(mensagem).data,
            status=status.HTTP_201_CREATED if criada else status.HTTP_200_OK,
        )


class LeituraConversaView(ChatAPIView):
    http_method_names = ("post", "options")

    def post(self, request, conversa_id):
        return Response(marcar_leitura(request.user, conversa_id, request.data))


class LogoutUsuarioView(ChatAPIView):
    http_method_names = ("post", "options")
    throttle_classes = ()

    def post(self, request):
        assinatura = assinatura_token(request.auth.key)
        Token.objects.filter(key=request.auth.key).delete()
        publicar_evento((request.user.pk,), {"assinatura": assinatura}, tipo="chat.revogar")
        return Response(status=status.HTTP_204_NO_CONTENT)
