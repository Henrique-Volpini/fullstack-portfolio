from django.contrib.auth import get_user_model
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError as ErroValidacaoDjango
from django.db import IntegrityError, transaction
from rest_framework import serializers


ModeloUsuario = get_user_model()


class LoginUsuarioSerializer(serializers.Serializer):
    username = serializers.CharField(required=True, max_length=150)
    password = serializers.CharField(
        required=True,
        max_length=64,
        write_only=True,
        trim_whitespace=False,
    )

    def validate_username(self, username):
        nome_normalizado = ModeloUsuario.normalize_username(username)
        if nome_normalizado != username:
            self.fields["username"].run_validators(nome_normalizado)
        return nome_normalizado


class CadastroUsuarioSerializer(serializers.ModelSerializer):

    password = serializers.CharField(
        required=True,
        max_length=64,
        write_only=True,
        trim_whitespace=False,
        style={"input_type": "password"},
    )

    class Meta:
        model = ModeloUsuario
        fields = ("id", "username", "email", "password")
        read_only_fields = ("id",)
        extra_kwargs = {
            "username": {"required": True},
            "email": {"required": False, "allow_blank": True},
        }

    def validate_username(self, username):
        nome_normalizado = ModeloUsuario.normalize_username(username)
        if nome_normalizado != username:
            self.fields["username"].run_validators(nome_normalizado)
        return nome_normalizado

    def validate(self, dados_cadastro):
        usuario_para_validacao = ModeloUsuario(
            username=dados_cadastro["username"],
            email=dados_cadastro.get("email", ""),
        )
        try:
            validate_password(
                dados_cadastro["password"], user=usuario_para_validacao
            )
        except ErroValidacaoDjango as erro_validacao:
            raise serializers.ValidationError(
                {"password": erro_validacao.messages}
            ) from erro_validacao
        return dados_cadastro

    def create(self, dados_validados):
        try:
            with transaction.atomic():
                return ModeloUsuario.objects.create_user(
                    username=dados_validados["username"],
                    email=dados_validados.get("email", ""),
                    password=dados_validados["password"],
                )
        except IntegrityError as erro_integridade:
            if ModeloUsuario.objects.filter(username=dados_validados["username"]).exists():
                raise serializers.ValidationError(
                    {"username": ["Este nome de usuário já está em uso."]}
                ) from erro_integridade
            raise
