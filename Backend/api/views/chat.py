import hashlib
import logging
from functools import partial
from types import SimpleNamespace
from uuid import uuid5

from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.db import DatabaseError, IntegrityError, transaction
from django.db.models import Count, F, Prefetch, Q
from django.shortcuts import get_object_or_404
from rest_framework import serializers, status
from rest_framework.exceptions import (
    APIException, AuthenticationFailed, NotFound, PermissionDenied, Throttled,
)
from rest_framework.generics import ListAPIView, RetrieveAPIView
from rest_framework.pagination import CursorPagination, PageNumberPagination
from rest_framework.response import Response
from rest_framework.throttling import UserRateThrottle
from rest_framework.views import APIView

from ..ia import AssistenteIndisponivel, LIMITE_HISTORICO, assistente_ativo, gerar_resposta
from ..models import Conversa, Mensagem
from ..serializers import (
    ConversaSerializer, CriarConversaSerializer, EnviarMensagemSerializer,
    MarcarLeituraSerializer, MensagemSerializer, UsuarioChatSerializer,
)


logger = logging.getLogger(__name__)


# Representa falhas temporárias do chat.
class ChatIndisponivel(APIException):
    status_code = 503
    default_detail = "O chat está temporariamente indisponível. Tente novamente."
    default_code = "chat_indisponivel"


# Representa conflitos no reenvio de uma mensagem.
class ConflitoMensagem(APIException):
    status_code = 409
    default_detail = "Este id_cliente já foi utilizado em outra mensagem."
    default_code = "conflito_mensagem"


# Verifica se o usuário pode atender as conversas.
def eh_operador(usuario):
    return bool(
        usuario.is_authenticated
        and usuario.is_active
        and usuario.is_superuser
    )


# Obtém os superusuários ativos responsáveis pelo chat.
def obter_operadores():
    usuarios = tuple(get_user_model().objects.filter(
        is_active=True, is_superuser=True
    ).values_list("pk", flat=True))
    if not usuarios:
        raise ChatIndisponivel("O responsável pelo chat ainda não está disponível.")
    return usuarios


# Monta o nome do grupo de eventos do usuário.
def grupo_usuario(usuario_id):
    return f"chat.usuario.{usuario_id}"


# Calcula a assinatura usada para identificar a revogação do token.
def assinatura_token(token):
    return hashlib.sha256(token.encode()).hexdigest()


# Publica um evento nos grupos dos usuários indicados.
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


# Restringe as conversas às permissões do usuário.
def conversas_permitidas(usuario):
    if not usuario.is_authenticated or not usuario.is_active:
        raise AuthenticationFailed()
    conversas = Conversa.objects.all()
    if not eh_operador(usuario):
        conversas = conversas.filter(usuario=usuario)
    return conversas


# Consulta conversas com a última mensagem e a contagem de não lidas.
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


# Busca uma conversa acessível ao usuário.
def obter_conversa(usuario, conversa_id):
    return get_object_or_404(conversas_permitidas(usuario).select_related("usuario"), pk=conversa_id)


# Cria ou recupera a conversa do usuário com o destinatário.
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


# Confere se o reenvio corresponde à mensagem já registrada.
def _verificar_repetida(mensagem, remetente, dados):
    remetente_id = remetente.pk if remetente is not None else None
    if mensagem.conteudo != dados["conteudo"] or mensagem.remetente_id != remetente_id:
        raise ConflitoMensagem()
    return mensagem, False


# Aplica o limite de envio de mensagens do usuário.
def _limitar_mensagem(remetente):
    limite = UserRateThrottle()
    if not limite.allow_request(SimpleNamespace(user=remetente), None):
        raise Throttled(wait=limite.wait())


# Salva a mensagem e publica o evento após a confirmação.
def _persistir_mensagem(conversa, remetente, origem, dados, *, limitar=True):
    anteriores = Mensagem.objects.select_related("remetente").filter(
        conversa=conversa, origem=origem, id_cliente=dados["id_cliente"]
    )
    anterior = anteriores.first()
    if anterior is not None:
        return _verificar_repetida(anterior, remetente, dados)

    operadores = obter_operadores()
    if remetente is not None and limitar:
        _limitar_mensagem(remetente)

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


# Valida e encaminha a mensagem ao destinatário da conversa.
def enviar_mensagem(usuario, conversa_id, dados):
    conversa = obter_conversa(usuario, conversa_id)
    validacao = EnviarMensagemSerializer(data=dados)
    validacao.is_valid(raise_exception=True)
    origem = Mensagem.Origem.HENRIQUE if eh_operador(usuario) else Mensagem.Origem.USUARIO
    if (
        origem == Mensagem.Origem.USUARIO
        and conversa.destinatario == Conversa.Destinatario.ASSISTENTE
        and assistente_ativo()
    ):
        return _enviar_para_assistente(conversa, usuario, validacao.validated_data)
    return _persistir_mensagem(conversa, usuario, origem, validacao.validated_data)


# Gera e salva a resposta do assistente para a conversa.
def _enviar_para_assistente(conversa, usuario, dados):
    chave_trava = f"chat.ia.{conversa.pk}"
    if not cache.add(chave_trava, True, timeout=30):
        raise AssistenteIndisponivel("O assistente já está respondendo nesta conversa. Tente novamente.")
    try:
        anterior = conversa.mensagens.select_related("remetente").filter(
            origem=Mensagem.Origem.USUARIO, id_cliente=dados["id_cliente"],
        ).first()
        id_resposta = uuid5(conversa.pk, str(dados["id_cliente"]))
        if anterior is not None:
            _verificar_repetida(anterior, usuario, dados)
            if conversa.mensagens.filter(
                origem=Mensagem.Origem.ASSISTENTE, id_cliente=id_resposta,
            ).exists():
                return anterior, False
        obter_operadores()
        _limitar_mensagem(usuario)
        mensagens = conversa.mensagens.order_by("-id")
        if anterior is not None:
            mensagens = mensagens.filter(id__lt=anterior.pk)
        historico = [
            {
                "role": "user" if origem == Mensagem.Origem.USUARIO else "model",
                "parts": [{"text": conteudo}],
            }
            for origem, conteudo in reversed(list(
                mensagens.values_list("origem", "conteudo")[:LIMITE_HISTORICO - 1]
            ))
        ]
        historico.append({"role": "user", "parts": [{"text": dados["conteudo"]}]})
        conteudo_resposta = gerar_resposta(historico)
        with transaction.atomic():
            mensagem, criada = _persistir_mensagem(
                conversa, usuario, Mensagem.Origem.USUARIO, dados, limitar=False,
            )
            registrar_resposta_assistente(conversa.pk, {
                "conteudo": conteudo_resposta, "id_cliente": id_resposta,
            })
        return mensagem, criada
    finally:
        cache.delete(chave_trava)


# Registra uma resposta com a identidade do assistente.
def registrar_resposta_assistente(conversa_id, dados):
    conversa = get_object_or_404(Conversa, pk=conversa_id, destinatario=Conversa.Destinatario.ASSISTENTE)
    validacao = EnviarMensagemSerializer(data=dados)
    validacao.is_valid(raise_exception=True)
    return _persistir_mensagem(conversa, None, Mensagem.Origem.ASSISTENTE, validacao.validated_data)


# Atualiza o marcador de leitura e notifica os participantes.
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


# Define a paginação da lista de conversas.
class ConversasPagination(PageNumberPagination):
    page_size = 20
    page_size_query_param = "tamanho"
    max_page_size = 100


# Define a paginação do histórico de mensagens por cursor.
class MensagensPagination(CursorPagination):
    page_size = 50
    page_size_query_param = "tamanho"
    max_page_size = 100
    ordering = "-id"

    # Valida a posição numérica do cursor de mensagens.
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

    # Define a ordem conforme a consulta de mensagens.
    def get_ordering(self, request, queryset, view):
        return ("id",) if "apos_id" in request.query_params else ("-id",)


# Compartilha as configurações das rotas HTTP do chat.
class ChatAPIView(APIView):
    throttle_scope = "chat"
    http_method_names = ("get", "post", "head", "options")

    # Converte falhas do banco em uma resposta de indisponibilidade.
    def handle_exception(self, exc):
        if isinstance(exc, DatabaseError):
            exc = ChatIndisponivel()
        return super().handle_exception(exc)


# Disponibiliza o perfil e as configurações iniciais do chat.
class ChatInicioView(ChatAPIView):
    http_method_names = ("get", "head", "options")

    # Retorna os dados necessários para iniciar o chat.
    def get(self, request):
        return Response({
            "usuario": UsuarioChatSerializer(request.user).data,
            "operador": eh_operador(request.user),
            "destinatarios": [
                {"id": valor, "nome": nome}
                for valor, nome in Conversa.Destinatario.choices
            ],
            "assistente_ia_ativo": assistente_ativo(),
            "websocket_path": "/ws/chat/",
        })


# Disponibiliza a listagem e a criação de conversas.
class ConversasView(ChatAPIView, ListAPIView):
    serializer_class = ConversaSerializer
    pagination_class = ConversasPagination

    # Seleciona as conversas acessíveis e aplica o filtro de destinatário.
    def get_queryset(self):
        conversas = consultar_conversas(self.request.user)
        destinatario = self.request.query_params.get("destinatario")
        if destinatario is not None:
            campo = serializers.ChoiceField(choices=Conversa.Destinatario.choices)
            conversas = conversas.filter(destinatario=campo.run_validation(destinatario))
        return conversas

    # Cria ou recupera uma conversa e retorna seus dados.
    def post(self, request):
        conversa, criada = criar_conversa(request.user, request.data)
        detalhada = consultar_conversas(request.user).get(pk=conversa.pk)
        return Response(
            ConversaSerializer(detalhada).data,
            status=status.HTTP_201_CREATED if criada else status.HTTP_200_OK,
        )


# Disponibiliza os detalhes de uma conversa autorizada.
class ConversaDetalheView(ChatAPIView, RetrieveAPIView):
    http_method_names = ("get", "head", "options")
    serializer_class = ConversaSerializer
    lookup_url_kwarg = "conversa_id"

    # Seleciona as conversas que o usuário pode consultar.
    def get_queryset(self):
        return consultar_conversas(self.request.user)


# Disponibiliza o histórico e o envio de mensagens.
class MensagensView(ChatAPIView, ListAPIView):
    serializer_class = MensagemSerializer
    pagination_class = MensagensPagination

    # Seleciona as mensagens autorizadas após o identificador informado.
    def get_queryset(self):
        conversa = obter_conversa(self.request.user, self.kwargs["conversa_id"])
        mensagens = conversa.mensagens.select_related("remetente").all()
        if "apos_id" in self.request.query_params:
            campo = serializers.IntegerField(min_value=0, max_value=9223372036854775807)
            mensagens = mensagens.filter(id__gt=campo.run_validation(self.request.query_params["apos_id"]))
        return mensagens

    # Envia a mensagem e retorna a confirmação do registro.
    def post(self, request, conversa_id):
        mensagem, criada = enviar_mensagem(request.user, conversa_id, request.data)
        return Response(
            MensagemSerializer(mensagem).data,
            status=status.HTTP_201_CREATED if criada else status.HTTP_200_OK,
        )


# Disponibiliza a atualização de leitura da conversa.
class LeituraConversaView(ChatAPIView):
    http_method_names = ("post", "options")

    # Marca a mensagem informada como lida na conversa.
    def post(self, request, conversa_id):
        return Response(marcar_leitura(request.user, conversa_id, request.data))
