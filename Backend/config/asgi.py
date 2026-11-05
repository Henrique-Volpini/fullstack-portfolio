import os

from django.core.asgi import get_asgi_application

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')

django_application = get_asgi_application()

from channels.routing import ProtocolTypeRouter, URLRouter
from channels.security.websocket import OriginValidator
from daphne import http_protocol
from django.conf import settings
from django.urls import path

from api.websocket import ChatConsumer


# Limita o tamanho das requisições HTTP recebidas pelo Daphne.
class RequisicaoHTTPLimitada(http_protocol.WebRequest):
    # Rejeita corpos cujo tamanho declarado excede o limite.
    def gotLength(self, length):
        self._bytes_recebidos = 0
        self._corpo_excedido = False
        limite = settings.DATA_UPLOAD_MAX_MEMORY_SIZE
        excedido = limite is not None and length is not None and length > limite
        super().gotLength(0 if excedido else length)
        if excedido:
            self._rejeitar_corpo()

    # Interrompe o recebimento quando os dados ultrapassam o limite.
    def handleContentChunk(self, data):
        if self._corpo_excedido:
            return
        self._bytes_recebidos += len(data)
        limite = settings.DATA_UPLOAD_MAX_MEMORY_SIZE
        if limite is not None and self._bytes_recebidos > limite:
            self._rejeitar_corpo()
            return
        super().handleContentChunk(data)

    # Processa somente requisições que respeitaram o limite de tamanho.
    def requestReceived(self, command, path, version):
        if not self._corpo_excedido:
            super().requestReceived(command, path, version)

    # Retorna erro 413 e encerra a conexão sem armazenar mais dados.
    def _rejeitar_corpo(self):
        self._corpo_excedido = True
        self.content.close()
        self.requestHeaders.removeHeader(b"Expect")
        corpo = b'{"detail":"Corpo da requisicao muito grande."}'
        self.setResponseCode(413)
        self.setHeader(b"Content-Type", b"application/json")
        self.setHeader(b"Content-Length", str(len(corpo)).encode("ascii"))
        self.setHeader(b"Connection", b"close")
        self.write(corpo)
        self.loseConnection()


http_protocol.WebRequest = RequisicaoHTTPLimitada

application = ProtocolTypeRouter({
    "http": django_application,
    "websocket": OriginValidator(
        URLRouter([
            path("ws/chat/", ChatConsumer.as_asgi()),
        ]),
        settings.CHAT_WEBSOCKET_ALLOWED_ORIGINS,
    ),
})
