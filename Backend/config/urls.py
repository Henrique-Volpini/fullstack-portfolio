from django.urls import path

from api.views import (
    CadastroUsuarioView, ChatInicioView, ConversaDetalheView, ConversasView,
    LeituraConversaView, LoginGoogleView, LoginUsuarioView,
    LogoutUsuarioView, MensagensView, health,
)

urlpatterns = [
    path("servidor/", health, name="servidor"),
    path("usuarios/", CadastroUsuarioView.as_view(), name="cadastro-usuario"),
    path("login/", LoginUsuarioView.as_view(), name="login-usuario"),
    path("login/google/", LoginGoogleView.as_view(), name="login-google"),
    path("logout/", LogoutUsuarioView.as_view(), name="logout-usuario"),
    
    path("chat/", ChatInicioView.as_view(), name="chat-inicio"),
    path("chat/conversas/", ConversasView.as_view(), name="chat-conversas"),
    path("chat/conversas/<uuid:conversa_id>/", ConversaDetalheView.as_view(), name="chat-conversa"),
    path("chat/conversas/<uuid:conversa_id>/mensagens/", MensagensView.as_view(), name="chat-mensagens"),
    path("chat/conversas/<uuid:conversa_id>/leitura/", LeituraConversaView.as_view(), name="chat-leitura"),
]
