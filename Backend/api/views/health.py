from django.http import JsonResponse
from django.views.decorators.cache import never_cache
from django.views.decorators.http import require_safe


# Confirma que o servidor está respondendo sem consultar o banco ou serviços externos.
@never_cache
@require_safe
def health(request):
    return JsonResponse({"status": "ok"})
