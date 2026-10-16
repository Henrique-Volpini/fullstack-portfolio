import uuid

from django.conf import settings
from django.db import models
from django.utils import timezone


class Conversa(models.Model):
    class Destinatario(models.TextChoices):
        HENRIQUE = "henrique", "Henrique"
        ASSISTENTE = "assistente", "Assistente"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    usuario = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="conversas"
    )
    destinatario = models.CharField(max_length=10, choices=Destinatario.choices)
    criada_em = models.DateTimeField(auto_now_add=True)
    atualizada_em = models.DateTimeField(default=timezone.now)
    ultima_lida_usuario = models.PositiveBigIntegerField(default=0)
    ultima_lida_henrique = models.PositiveBigIntegerField(default=0)

    class Meta:
        ordering = ("-atualizada_em", "-id")
        constraints = [
            models.UniqueConstraint(
                fields=("usuario", "destinatario"), name="chat_conversa_unica"
            ),
            models.CheckConstraint(
                condition=models.Q(destinatario__in=("henrique", "assistente")),
                name="chat_destinatario_valido",
            ),
        ]

    def __str__(self):
        return f"{self.usuario} → {self.get_destinatario_display()}"


class Mensagem(models.Model):
    class Origem(models.TextChoices):
        USUARIO = "usuario", "Usuário"
        HENRIQUE = "henrique", "Henrique"
        ASSISTENTE = "assistente", "Assistente"

    conversa = models.ForeignKey(
        Conversa, on_delete=models.CASCADE, related_name="mensagens"
    )
    remetente = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        related_name="mensagens_chat",
        null=True,
        blank=True,
    )
    origem = models.CharField(max_length=10, choices=Origem.choices)
    conteudo = models.CharField(max_length=4000)
    id_cliente = models.UUIDField()
    criada_em = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ("id",)
        indexes = [models.Index(fields=("conversa", "id"), name="chat_historico_idx")]
        constraints = [
            models.UniqueConstraint(
                fields=("conversa", "origem", "id_cliente"),
                name="chat_mensagem_idempotente",
            ),
            models.CheckConstraint(
                condition=(
                    models.Q(origem="assistente", remetente__isnull=True)
                    | models.Q(
                        origem__in=("usuario", "henrique"), remetente__isnull=False
                    )
                ),
                name="chat_remetente_valido",
            ),
            models.CheckConstraint(
                condition=~models.Q(conteudo=""), name="chat_conteudo_nao_vazio"
            ),
        ]

    def __str__(self):
        return f"Mensagem {self.pk} — {self.get_origem_display()}"
