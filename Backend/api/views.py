from django.contrib.auth import authenticate
from rest_framework import status
from rest_framework.authtoken.models import Token
from rest_framework.generics import CreateAPIView
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from .serializers import CadastroUsuarioSerializer, LoginUsuarioSerializer


class CadastroUsuarioView(CreateAPIView):

    serializer_class = CadastroUsuarioSerializer
    permission_classes = (AllowAny,)
    authentication_classes = ()
    http_method_names = ("post", "options")


class LoginUsuarioView(APIView):
    permission_classes = (AllowAny,)
    authentication_classes = ()
    http_method_names = ("post", "options")

    def post(self, request):
        validacao_login = LoginUsuarioSerializer(data=request.data)
        validacao_login.is_valid(raise_exception=True)

        usuario = authenticate(
            request=request,
            username=validacao_login.validated_data["username"],
            password=validacao_login.validated_data["password"],
        )

        if usuario is None:
            return Response(
                {"erro": "Usuário ou senha incorretos."},
                status=status.HTTP_401_UNAUTHORIZED,
                headers={"WWW-Authenticate": "Token"},
            )

        token_acesso, _ = Token.objects.get_or_create(user=usuario)

        return Response(
            {
                "token": token_acesso.key,
                "usuario": CadastroUsuarioSerializer(usuario).data,
            },
            status=status.HTTP_200_OK,
        )
