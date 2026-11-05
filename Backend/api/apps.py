from django.apps import AppConfig


# Configura a aplicação de API no Django.
class ApiConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'api'
