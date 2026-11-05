from collections.abc import Mapping

from django.contrib.auth import get_user_model
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError as ErroValidacaoDjango
from django.core.validators import RegexValidator
from django.db import IntegrityError, transaction
from google.auth import jwt as google_jwt
from google.auth.exceptions import GoogleAuthError
from rest_framework import serializers

from .models import Conversa, Mensagem


ModeloUsuario = get_user_model()


# Valida os dados recebidos no login com Google.
class LoginGoogleSerializer(serializers.Serializer):
    credential = serializers.CharField(max_length=8192, trim_whitespace=False)

    # Rejeita credenciais Google com estrutura JWT inválida.
    def validate_credential(self, credential):
        if not isinstance(self.initial_data.get("credential"), str) or not credential.strip():
            raise serializers.ValidationError("Informe a credencial do Google como texto.")
        try:
            RegexValidator(r"\A[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\Z")(credential)
            cabecalho = google_jwt.decode_header(credential)
            if (
                cabecalho.get("alg") != "RS256"
                or not isinstance(cabecalho.get("kid"), str) or not cabecalho["kid"].strip()
            ):
                raise ValueError
        except (ErroValidacaoDjango, ValueError, GoogleAuthError, RecursionError):
            raise serializers.ValidationError("Informe uma credencial Google no formato JWT válido.") from None
        return credential


# Valida os dados de login por usuário e senha.
class LoginUsuarioSerializer(serializers.Serializer):
    username = serializers.CharField(max_length=150)
    password = serializers.CharField(
        max_length=64,
        write_only=True,
        trim_whitespace=False,
    )

    # Normaliza o nome de usuário antes da autenticação.
    def validate_username(self, username):
        nome_normalizado = ModeloUsuario.normalize_username(username)
        if nome_normalizado != username:
            self.fields["username"].run_validators(nome_normalizado)
        return nome_normalizado


# Valida e cria contas de usuário.
class CadastroUsuarioSerializer(serializers.ModelSerializer):

    password = serializers.CharField(
        max_length=64,
        write_only=True,
        trim_whitespace=False,
        style={"input_type": "password"},
    )

    # Define o modelo e os campos de cadastro.
    class Meta:
        model = ModeloUsuario
        fields = ("id", "username", "email", "password")
        read_only_fields = ("id",)

    # Normaliza o nome de usuário informado no cadastro.
    def validate_username(self, username):
        nome_normalizado = ModeloUsuario.normalize_username(username)
        if nome_normalizado != username:
            self.fields["username"].run_validators(nome_normalizado)
        return nome_normalizado

    # Valida a senha conforme as regras do Django.
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

    # Cria a conta e trata nomes de usuário duplicados.
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


# Expõe os dados básicos do usuário no chat.
class UsuarioChatSerializer(serializers.ModelSerializer):
    # Define os campos públicos do usuário no chat.
    class Meta:
        model = ModeloUsuario
        fields = ("id", "username")
        read_only_fields = fields


# Serializa os dados das mensagens do chat.
class MensagemSerializer(serializers.ModelSerializer):
    conversa_id = serializers.UUIDField(read_only=True)
    remetente = serializers.SerializerMethodField()

    # Define os campos de saída das mensagens.
    class Meta:
        model = Mensagem
        fields = (
            "id", "conversa_id", "remetente", "origem", "conteudo",
            "id_cliente", "criada_em",
        )
        read_only_fields = fields

    # Identifica o remetente exibido na mensagem.
    def get_remetente(self, mensagem):
        if mensagem.origem == Mensagem.Origem.HENRIQUE:
            return {"id": None, "nome": "Henrique"}
        if mensagem.origem == Mensagem.Origem.ASSISTENTE:
            return {"id": None, "nome": "Assistente"}
        return {"id": mensagem.remetente_id, "nome": mensagem.remetente.username}


# Serializa conversas e seus dados de leitura.
class ConversaSerializer(serializers.ModelSerializer):
    usuario = UsuarioChatSerializer(read_only=True)
    nome_destinatario = serializers.CharField(source="get_destinatario_display", read_only=True)
    nao_lidas = serializers.IntegerField(read_only=True)
    ultima_mensagem = serializers.SerializerMethodField()

    # Define os campos de saída das conversas.
    class Meta:
        model = Conversa
        fields = (
            "id", "usuario", "destinatario", "nome_destinatario", "criada_em",
            "atualizada_em", "nao_lidas", "ultima_mensagem", "ultima_lida_usuario",
            "ultima_lida_henrique",
        )
        read_only_fields = fields

    # Retorna a mensagem mais recente da conversa.
    def get_ultima_mensagem(self, conversa):
        mensagens = conversa.ultimas_mensagens
        return MensagemSerializer(mensagens[0]).data if mensagens else None


# Rejeita campos extras nas entradas do chat.
class EntradaChatSerializer(serializers.Serializer):
    # Converte a entrada e rejeita campos não permitidos.
    def to_internal_value(self, data):
        if isinstance(data, Mapping):
            desconhecidos = set(data) - set(self.fields)
            if desconhecidos:
                raise serializers.ValidationError({
                    campo: ["Campo não permitido."] for campo in sorted(desconhecidos)
                })
        return super().to_internal_value(data)


# Valida o destinatário de uma nova conversa.
class CriarConversaSerializer(EntradaChatSerializer):
    destinatario = serializers.ChoiceField(choices=Conversa.Destinatario.choices)


# Valida os dados de uma mensagem enviada.
class EnviarMensagemSerializer(EntradaChatSerializer):
    conteudo = serializers.CharField(max_length=4000)
    id_cliente = serializers.UUIDField()

    # Exige conteúdo de mensagem em formato de texto.
    def validate_conteudo(self, conteudo):
        if not isinstance(self.initial_data.get("conteudo"), str):
            raise serializers.ValidationError("Envie uma mensagem de texto.")
        return conteudo


# Valida o identificador da mensagem marcada como lida.
class MarcarLeituraSerializer(EntradaChatSerializer):
    mensagem_id = serializers.IntegerField(min_value=1, max_value=9223372036854775807)
