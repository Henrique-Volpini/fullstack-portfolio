"""
ASGI config for config project.

It exposes the ASGI callable as a module-level variable named ``application``.

For more information on this file, see
https://docs.djangoproject.com/en/5.2/howto/deployment/asgi/
"""

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


class RequisicaoHTTPLimitada(http_protocol.WebRequest):
    """Limita o corpo antes de o Daphne armazená-lo ou entregá-lo ao Django."""

    def gotLength(self, length):
        self._bytes_recebidos = 0
        self._corpo_excedido = False
        limite = settings.DATA_UPLOAD_MAX_MEMORY_SIZE
        excedido = limite is not None and length is not None and length > limite
        super().gotLength(0 if excedido else length)
        if excedido:
            self._rejeitar_corpo()

    def handleContentChunk(self, data):
        if self._corpo_excedido:
            return
        self._bytes_recebidos += len(data)
        limite = settings.DATA_UPLOAD_MAX_MEMORY_SIZE
        if limite is not None and self._bytes_recebidos > limite:
            self._rejeitar_corpo()
            return
        super().handleContentChunk(data)

    def requestReceived(self, command, path, version):
        if not self._corpo_excedido:
            super().requestReceived(command, path, version)

    def _rejeitar_corpo(self):
        self._corpo_excedido = True
        self.content.close()
        # Não enviar 100 Continue depois da rejeição nem reutilizar esta conexão.
        self.requestHeaders.removeHeader(b"Expect")
        corpo = b'{"detail":"Corpo da requisicao muito grande."}'
        self.setResponseCode(413)
        self.setHeader(b"Content-Type", b"application/json")
        self.setHeader(b"Content-Length", str(len(corpo)).encode("ascii"))
        self.setHeader(b"Connection", b"close")
        self.write(corpo)
        self.loseConnection()


# O Daphne 4.2 consulta esta classe ao abrir cada conexão. O limite nativo do
# Django só atua após o buffer do servidor, por isso o teto também é aplicado aqui.
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
