"""
URL configuration for config project.

The `urlpatterns` list routes URLs to views. For more information please see:
    https://docs.djangoproject.com/en/5.2/topics/http/urls/
Examples:
Function views
    1. Add an import:  from my_app import views
    2. Add a URL to urlpatterns:  path('', views.home, name='home')
Class-based views
    1. Add an import:  from other_app.views import Home
    2. Add a URL to urlpatterns:  path('', Home.as_view(), name='home')
Including another URLconf
    1. Import the include() function: from django.urls import include, path
    2. Add a URL to urlpatterns:  path('blog/', include('blog.urls'))
"""
from django.contrib import admin
from django.urls import path

from api.views import (
    CadastroUsuarioView, ChatInicioView, ConversaDetalheView, ConversasView,
    LeituraConversaView, LoginUsuarioView,
    LogoutUsuarioView, MensagensView,
)

urlpatterns = [
    path('admin/', admin.site.urls),
    path("usuarios/", CadastroUsuarioView.as_view(), name="cadastro-usuario"),
    path("login/", LoginUsuarioView.as_view(), name="login-usuario"),
    path("logout/", LogoutUsuarioView.as_view(), name="logout-usuario"),
    path("chat/", ChatInicioView.as_view(), name="chat-inicio"),
    path("chat/conversas/", ConversasView.as_view(), name="chat-conversas"),
    path("chat/conversas/<uuid:conversa_id>/", ConversaDetalheView.as_view(), name="chat-conversa"),
    path("chat/conversas/<uuid:conversa_id>/mensagens/", MensagensView.as_view(), name="chat-mensagens"),
    path("chat/conversas/<uuid:conversa_id>/leitura/", LeituraConversaView.as_view(), name="chat-leitura"),
]
