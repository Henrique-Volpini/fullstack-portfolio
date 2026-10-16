import asyncio
import json
import math
from collections import deque
from contextlib import suppress
from time import monotonic
from types import SimpleNamespace

from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncJsonWebsocketConsumer
from django.conf import settings
from django.db import DatabaseError
from django.http import Http404
from rest_framework import serializers
from rest_framework.authtoken.models import Token
from rest_framework.exceptions import APIException, AuthenticationFailed, NotFound, Throttled, ValidationError
from redis.exceptions import RedisError

from .views import (
    ChatIndisponivel, WebsocketThrottle, assinatura_token, eh_operador,
    conversas_permitidas, enviar_mensagem, grupo_usuario, marcar_leitura,
)
from .serializers import MensagemSerializer, UsuarioChatSerializer


@database_sync_to_async
def autenticar_token(token):
    acesso = Token.objects.select_related("user").filter(key=token).first()
    if acesso is None or not acesso.user.is_active:
        raise AuthenticationFailed("Acesso inválido ou encerrado.")
    return acesso.user


@database_sync_to_async
def limitar_conexao(ip):
    limite = WebsocketThrottle()
    if not limite.allow_request(SimpleNamespace(META={"REMOTE_ADDR": ip}), None):
        raise Throttled(wait=limite.wait())


class ChatConsumer(AsyncJsonWebsocketConsumer):
    async def connect(self):
        self.usuario = None
        self.token = None
        self.operador = False
        self.grupo = None
        self.fechando = False
        self.prazo_autenticacao = None
        self.eventos_recebidos = deque()
        if self.scope.get("query_string"):
            await self.close(code=4400)
            return
        try:
            cliente = self.scope.get("client")
            await limitar_conexao(cliente[0] if cliente else "desconhecido")
        except Throttled:
            await self.close(code=4429)
            return
        except DatabaseError:
            await self.close(code=1013)
            return
        await self.accept()
        await self.send_json({
            "type": "autenticacao.necessaria",
            "prazo_segundos": settings.CHAT_WEBSOCKET_AUTH_TIMEOUT,
        })
        self.prazo_autenticacao = asyncio.create_task(self._aguardar_autenticacao())

    async def _aguardar_autenticacao(self):
        await asyncio.sleep(settings.CHAT_WEBSOCKET_AUTH_TIMEOUT)
        if self.usuario is None:
            self.fechando = True
            await self.close(code=4401)

    async def disconnect(self, close_code):
        self.fechando = True
        await self._cancelar_prazo()
        if self.grupo is not None:
            try:
                await self.channel_layer.group_discard(self.grupo, self.channel_name)
            except Exception:
                pass

    async def receive(self, text_data=None, bytes_data=None, **kwargs):
        if self.fechando:
            return
        if bytes_data is not None:
            await self._fechar(1003)
            return
        try:
            if len((text_data or "").encode("utf-8")) > settings.CHAT_WEBSOCKET_MAX_BYTES:
                await self._fechar(1009)
                return
            agora = monotonic()
            while self.eventos_recebidos and self.eventos_recebidos[0] <= agora - 60:
                self.eventos_recebidos.popleft()
            if len(self.eventos_recebidos) >= 120:
                await self._fechar(4429)
                return
            self.eventos_recebidos.append(agora)
            dados = json.loads(text_data or "")
        except (ValueError, RecursionError, UnicodeError):
            await self._erro(ValidationError("JSON inválido."))
            if self.usuario is None:
                await self._fechar(4401)
            return
        if not isinstance(dados, dict) or not isinstance(dados.get("type"), str):
            await self._erro(ValidationError("Envie um objeto com o campo type."))
            if self.usuario is None:
                await self._fechar(4401)
            return
        try:
            if self.usuario is None:
                await self._autenticar(dados)
                return
            if not await self._validar_acesso():
                return
            await self.channel_layer.group_add(self.grupo, self.channel_name)
            tipo = dados["type"]
            if tipo == "ping":
                if set(dados) != {"type"}:
                    raise ValidationError("O ping aceita somente o campo type.")
                await self.send_json({"type": "pong"})
            elif tipo in {"mensagem.enviar", "conversa.ler"}:
                campo = serializers.UUIDField()
                conversa_id = campo.run_validation(dados.get("conversa_id"))
                conteudo = {k: v for k, v in dados.items() if k not in {"type", "conversa_id"}}
                if tipo == "mensagem.enviar":
                    resposta = await self._enviar(conversa_id, conteudo)
                    await self.send_json(resposta)
                else:
                    resposta = await database_sync_to_async(marcar_leitura)(
                        self.usuario, conversa_id, conteudo
                    )
                    await self.send_json({**resposta, "type": "leitura.confirmada"})
            else:
                raise ValidationError("Tipo de evento não suportado.")
        except AuthenticationFailed as erro:
            await self._erro(erro, dados)
            await self._fechar(4401)
        except Http404:
            await self._erro(NotFound("Conversa não encontrada."), dados)
        except APIException as erro:
            await self._erro(erro, dados)
            if self.usuario is None:
                await self._fechar(4401)
        except DatabaseError:
            await self._erro(ChatIndisponivel(), dados)
        except (OSError, TimeoutError, RedisError):
            await self._erro(ChatIndisponivel(), dados)
            await self._fechar(1013)

    async def _autenticar(self, dados):
        if dados["type"] != "autenticar" or set(dados) != {"type", "token"}:
            raise AuthenticationFailed("Autentique a conexão antes de usar o chat.")
        token = dados["token"]
        if not isinstance(token, str) or len(token) != 40 or any(c not in "0123456789abcdef" for c in token):
            raise AuthenticationFailed("Acesso inválido ou encerrado.")
        usuario = await autenticar_token(token)
        if self.fechando:
            return
        grupo = grupo_usuario(usuario.pk)
        await self.channel_layer.group_add(grupo, self.channel_name)
        if self.fechando:
            await self.channel_layer.group_discard(grupo, self.channel_name)
            return
        self.token = token
        self.usuario = usuario
        self.operador = eh_operador(usuario)
        self.grupo = grupo
        await self._cancelar_prazo()
        await self.send_json({
            "type": "autenticado", "usuario": UsuarioChatSerializer(usuario).data,
            "operador": self.operador,
        })

    async def _validar_acesso(self):
        usuario = await autenticar_token(self.token)
        if eh_operador(usuario) != self.operador:
            await self._fechar(4403)
            return False
        self.usuario = usuario
        return True

    @database_sync_to_async
    def _enviar(self, conversa_id, dados):
        mensagem, criada = enviar_mensagem(self.usuario, conversa_id, dados)
        return {
            "type": "mensagem.confirmada", "mensagem": MensagemSerializer(mensagem).data,
            "repetida": not criada,
        }

    async def _erro(self, erro, comando=None):
        if self.fechando:
            return
        dados = {
            "type": "erro", "codigo": erro.default_code,
            "status": erro.status_code, "erros": erro.detail,
        }
        if isinstance(erro, Throttled) and erro.wait is not None:
            dados["tente_novamente_em"] = math.ceil(erro.wait)
        if comando and comando.get("type") in {"mensagem.enviar", "conversa.ler"}:
            dados["comando"] = comando["type"]
            for campo in ("conversa_id", "id_cliente"):
                try:
                    dados[campo] = str(serializers.UUIDField().run_validation(comando.get(campo)))
                except ValidationError:
                    pass
        await self.send_json(dados)

    async def _fechar(self, codigo):
        if self.fechando:
            return
        self.fechando = True
        await self._cancelar_prazo()
        await self.close(code=codigo)

    async def _cancelar_prazo(self):
        if self.prazo_autenticacao is not None:
            self.prazo_autenticacao.cancel()
            with suppress(asyncio.CancelledError):
                await self.prazo_autenticacao
            self.prazo_autenticacao = None

    async def chat_evento(self, evento):
        if self.fechando or self.usuario is None:
            return
        try:
            if await self._validar_acesso() and await self._pode_receber(evento["dados"]):
                await self.send_json(evento["dados"])
        except AuthenticationFailed:
            await self._fechar(4401)
        except DatabaseError:
            await self._fechar(1013)

    @database_sync_to_async
    def _pode_receber(self, dados):
        conversa_id = dados.get("conversa_id") or dados.get("mensagem", {}).get("conversa_id")
        if not conversa_id:
            return False
        return conversas_permitidas(self.usuario).filter(pk=conversa_id).exists()

    async def chat_revogar(self, evento):
        if self.token and assinatura_token(self.token) == evento["dados"]["assinatura"]:
            await self._fechar(4401)
