import os
from datetime import timedelta
from pathlib import Path

from django.core.exceptions import ImproperlyConfigured
from dotenv import load_dotenv
from psycopg import ProgrammingError
from psycopg.conninfo import conninfo_to_dict

BASE_DIR = Path(__file__).resolve().parent.parent

load_dotenv(BASE_DIR / ".env", override=False)

GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "").strip()
GEMINI_API_KEY = os.environ.get("GEMINI_KEY", "").strip()
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.5-flash-lite").strip()

try:
    AUTH_TOKEN_TTL_SECONDS = int(os.environ.get("DJANGO_TOKEN_TTL_SECONDS", "3600"))
    if AUTH_TOKEN_TTL_SECONDS <= 0:
        raise ValueError
except ValueError:
    raise ImproperlyConfigured(
        "DJANGO_TOKEN_TTL_SECONDS deve ser um número inteiro maior que zero."
    ) from None


SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY", "").strip()
if not SECRET_KEY:
    raise ImproperlyConfigured(
        "Defina DJANGO_SECRET_KEY no ambiente ou no arquivo Backend/.env."
    )

DEBUG = os.environ.get("DJANGO_DEBUG", "False").strip().lower() in {"true", "1", "yes", "on"}

ALLOWED_HOSTS = [
    host.strip()
    for host in os.environ.get("DJANGO_ALLOWED_HOSTS", "").split(",")
    if host.strip()
]
render_hostname = os.environ.get("RENDER_EXTERNAL_HOSTNAME", "").strip()
if render_hostname and render_hostname not in ALLOWED_HOSTS:
    ALLOWED_HOSTS.append(render_hostname)

if os.environ.get("RENDER") == "true":
    SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
SECURE_SSL_REDIRECT = not DEBUG
SESSION_COOKIE_SECURE = not DEBUG
CSRF_COOKIE_SECURE = not DEBUG


INSTALLED_APPS = [
    'daphne',
    'django.contrib.admin',
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.sessions',
    'django.contrib.messages',
    'django.contrib.staticfiles',
    'corsheaders',
    'rest_framework',
    'rest_framework.authtoken',
    'axes',
    'api',
]

CHAT_WEBSOCKET_AUTH_TIMEOUT = 10
CHAT_WEBSOCKET_MAX_BYTES = 32768
DATA_UPLOAD_MAX_MEMORY_SIZE = 64 * 1024

MIDDLEWARE = [
    'django.middleware.security.SecurityMiddleware',
    'corsheaders.middleware.CorsMiddleware',
    'django.contrib.sessions.middleware.SessionMiddleware',
    'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    'django.contrib.messages.middleware.MessageMiddleware',
    'django.middleware.clickjacking.XFrameOptionsMiddleware',
    'axes.middleware.AxesMiddleware',
]

AUTHENTICATION_BACKENDS = [
    "axes.backends.AxesStandaloneBackend",
    "django.contrib.auth.backends.ModelBackend",
]

AXES_FAILURE_LIMIT = 5
AXES_COOLOFF_TIME = timedelta(minutes=15)
AXES_LOCKOUT_PARAMETERS = ["username"]
AXES_RESET_COOL_OFF_ON_FAILURE_DURING_LOCKOUT = False
AXES_LOCKOUT_CALLABLE = "api.views.usuarios.resposta_bloqueio"

CORS_ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.environ.get("DJANGO_CORS_ALLOWED_ORIGINS", "").split(",")
    if origin.strip()
]

REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": [
        "api.authentication.TokenExpiravelAuthentication",
    ],
    "DEFAULT_PERMISSION_CLASSES": [
        "rest_framework.permissions.IsAuthenticated",
    ],
    "DEFAULT_THROTTLE_CLASSES": [
        "rest_framework.throttling.ScopedRateThrottle",
    ],
    "DEFAULT_THROTTLE_RATES": {
        "login": "20/min",
        "cadastro": "5/hour",
        "chat": "120/min",
        "user": "60/min",
        "anon": "20/min",
    },
    "NUM_PROXIES": 0,
}

CACHES = {
    "default": {
        "BACKEND": "django.core.cache.backends.db.DatabaseCache",
        "LOCATION": "cache_autenticacao",
    },
}

ROOT_URLCONF = 'config.urls'

TEMPLATES = [
    {
        'BACKEND': 'django.template.backends.django.DjangoTemplates',
        'DIRS': [],
        'APP_DIRS': True,
        'OPTIONS': {
            'context_processors': [
                'django.template.context_processors.request',
                'django.contrib.auth.context_processors.auth',
                'django.contrib.messages.context_processors.messages',
            ],
        },
    },
]

WSGI_APPLICATION = 'config.wsgi.application'
ASGI_APPLICATION = 'config.asgi.application'

REDIS_URL = os.environ.get("REDIS_URL", "").strip()
if not DEBUG and not REDIS_URL:
    raise ImproperlyConfigured("Defina REDIS_URL para habilitar o chat em produção.")
CHANNEL_LAYERS = {
    "default": {
        "BACKEND": "channels_redis.core.RedisChannelLayer",
        "CONFIG": {
            "hosts": [{
                "address": REDIS_URL or "redis://127.0.0.1:6379/0",
                "socket_connect_timeout": 2,
                # O Channels controla o prazo de sua leitura bloqueante.
                "socket_timeout": None,
            }],
            "prefix": "portfolio-chat",
        },
    },
}
if DEBUG and not REDIS_URL:
    CHANNEL_LAYERS = {
        "default": {"BACKEND": "channels.layers.InMemoryChannelLayer"},
    }

CHAT_WEBSOCKET_ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.environ.get(
        "CHAT_WEBSOCKET_ALLOWED_ORIGINS", ",".join(CORS_ALLOWED_ORIGINS)
    ).split(",")
    if origin.strip()
]
if DEBUG:
    CHAT_WEBSOCKET_ALLOWED_ORIGINS += ["localhost", "127.0.0.1"]


database_url = os.environ.get("DATABASE_URL", "").strip()
if database_url:
    try:
        database_config = conninfo_to_dict(database_url)
        database_name = database_config.pop("dbname", "")
        if not database_name:
            raise ProgrammingError
    except ProgrammingError:
        raise ImproperlyConfigured(
            "DATABASE_URL deve informar uma conexão PostgreSQL válida com o nome do banco."
        ) from None
    DATABASES = {
        "default": {
            "ENGINE": "django.db.backends.postgresql",
            "NAME": database_name,
            "USER": database_config.pop("user", ""),
            "PASSWORD": database_config.pop("password", ""),
            "HOST": database_config.pop("host", ""),
            "PORT": database_config.pop("port", ""),
            "OPTIONS": {"connect_timeout": 10, **database_config},
        },
    }
elif DEBUG:
    DATABASES = {
        "default": {
            "ENGINE": "django.db.backends.sqlite3",
            "NAME": BASE_DIR / "db.sqlite3",
        },
    }
else:
    raise ImproperlyConfigured("Defina DATABASE_URL para conectar ao PostgreSQL em produção.")


AUTH_PASSWORD_VALIDATORS = [
    {
        'NAME': 'django.contrib.auth.password_validation.UserAttributeSimilarityValidator',
    },
    {
        'NAME': 'django.contrib.auth.password_validation.MinimumLengthValidator',
    },
    {
        'NAME': 'django.contrib.auth.password_validation.CommonPasswordValidator',
    },
    {
        'NAME': 'django.contrib.auth.password_validation.NumericPasswordValidator',
    },
]


LANGUAGE_CODE = 'pt-br'

TIME_ZONE = 'America/Sao_Paulo'

USE_I18N = True

USE_TZ = True


STATIC_URL = 'static/'

DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'
