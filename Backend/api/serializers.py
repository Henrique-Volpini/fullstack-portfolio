import base64
import binascii
import json
import re
from collections.abc import Mapping

from django.contrib.auth import get_user_model
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError as ErroValidacaoDjango
from django.db import IntegrityError, transaction
from rest_framework import serializers

from .ia import BASE_PORTFOLIO
from .models import Conversa, Mensagem


ModeloUsuario = get_user_model()


class LoginGoogleSerializer(serializers.Serializer):
    credential = serializers.CharField(max_length=8192, trim_whitespace=False)

    def validate_credential(self, credential):
        if not isinstance(self.initial_data.get("credential"), str) or not credential.strip():
            raise serializers.ValidationError("Informe a credencial do Google como texto.")
        try:
            partes = credential.split(".")
            if len(partes) != 3 or any(
                re.fullmatch(r"[A-Za-z0-9_-]+", parte) is None for parte in partes
            ):
                raise ValueError
            decodificadas = [
                base64.b64decode(parte + "=" * (-len(parte) % 4), altchars=b"-_", validate=True)
                for parte in partes
            ]
            cabecalho, corpo = [json.loads(parte.decode("utf-8")) for parte in decodificadas[:2]]
            if (
                not isinstance(cabecalho, dict) or not isinstance(corpo, dict)
                or cabecalho.get("alg") != "RS256"
                or not isinstance(cabecalho.get("kid"), str) or not cabecalho["kid"].strip()
            ):
                raise ValueError
        except (ValueError, binascii.Error, UnicodeError, RecursionError):
            raise serializers.ValidationError("Informe uma credencial Google no formato JWT válido.") from None
        # Os dados decodificados não são confiáveis até a verificação criptográfica.
        return credential


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


class UsuarioChatSerializer(serializers.ModelSerializer):
    class Meta:
        model = ModeloUsuario
        fields = ("id", "username")
        read_only_fields = fields


class MensagemSerializer(serializers.ModelSerializer):
    conversa_id = serializers.UUIDField(read_only=True)
    remetente = serializers.SerializerMethodField()

    class Meta:
        model = Mensagem
        fields = (
            "id", "conversa_id", "remetente", "origem", "conteudo",
            "id_cliente", "criada_em",
        )
        read_only_fields = fields

    def get_remetente(self, mensagem):
        if mensagem.origem == Mensagem.Origem.HENRIQUE:
            return {"id": None, "nome": "Henrique"}
        if mensagem.origem == Mensagem.Origem.ASSISTENTE:
            return {"id": None, "nome": "Assistente"}
        return {"id": mensagem.remetente_id, "nome": mensagem.remetente.username}


class ConversaSerializer(serializers.ModelSerializer):
    usuario = UsuarioChatSerializer(read_only=True)
    nome_destinatario = serializers.CharField(source="get_destinatario_display", read_only=True)
    nao_lidas = serializers.IntegerField(read_only=True)
    ultima_mensagem = serializers.SerializerMethodField()

    class Meta:
        model = Conversa
        fields = (
            "id", "usuario", "destinatario", "nome_destinatario", "criada_em",
            "atualizada_em", "nao_lidas", "ultima_mensagem", "ultima_lida_usuario",
            "ultima_lida_henrique",
        )
        read_only_fields = fields

    def get_ultima_mensagem(self, conversa):
        mensagens = conversa.ultimas_mensagens
        return MensagemSerializer(mensagens[0]).data if mensagens else None


class EntradaChatSerializer(serializers.Serializer):
    def to_internal_value(self, data):
        if isinstance(data, Mapping):
            desconhecidos = set(data) - set(self.fields)
            if desconhecidos:
                raise serializers.ValidationError({
                    campo: ["Campo não permitido."] for campo in sorted(desconhecidos)
                })
        return super().to_internal_value(data)


class CriarConversaSerializer(EntradaChatSerializer):
    destinatario = serializers.ChoiceField(choices=Conversa.Destinatario.choices)


class EnviarMensagemSerializer(EntradaChatSerializer):
    conteudo = serializers.CharField(max_length=4000, allow_blank=False)
    id_cliente = serializers.UUIDField()

    def validate_conteudo(self, conteudo):
        if not isinstance(self.initial_data.get("conteudo"), str):
            raise serializers.ValidationError("Envie uma mensagem de texto.")
        return conteudo


class RespostaIASerializer(EntradaChatSerializer):
    topicos = serializers.ListField(
        child=serializers.ChoiceField(choices=tuple(BASE_PORTFOLIO)),
        max_length=3,
        allow_empty=True,
    )


class MarcarLeituraSerializer(EntradaChatSerializer):
    mensagem_id = serializers.IntegerField(min_value=1, max_value=9223372036854775807)
