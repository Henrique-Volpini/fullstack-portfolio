import { texts } from "../../texts";

export const apiUrl = (import.meta.env.VITE_API_URL?.trim() || "/api").replace(/\/+$/, "");

// Com quem o visitante conversa: o Henrique ou o assistente de IA.
export type Destinatario = "henrique" | "assistente";
// Quem escreveu a mensagem.
export type Origem = "usuario" | "henrique" | "assistente";

// Mensagem do chat como a API a devolve.
export type Mensagem = {
  id: number;
  conversa_id: string;
  remetente: { id: number | null; nome: string };
  origem: Origem;
  conteudo: string;
  id_cliente: string;
  criada_em: string;
};

// Conversa entre um visitante e um destinatário, com não lidas e marcadores de leitura.
export type Conversa = {
  id: string;
  usuario: { id: number; username: string };
  destinatario: Destinatario;
  nome_destinatario: string;
  criada_em: string;
  atualizada_em: string;
  nao_lidas: number;
  ultima_mensagem: Mensagem | null;
  ultima_lida_usuario: number;
  ultima_lida_henrique: number;
};

// Perfil do usuário logado: se é operador, destinatários disponíveis e caminho do WebSocket.
export type Perfil = {
  usuario: { id: number; username: string };
  operador: boolean;
  destinatarios: Array<{ id: Destinatario; nome: string }>;
  assistente_ia_ativo: boolean;
  websocket_path: string;
};

// Resposta paginada da API.
export type Pagina<T> = { next: string | null; previous: string | null; results: T[] };

// Confirmação de leitura: quem leu e até qual mensagem.
type Leitura = { por: "usuario" | "henrique"; mensagem_id: number };

// Erro de requisição à API, com o status HTTP e uma mensagem pronta para o usuário.
export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

// Extrai o campo detail de uma resposta de erro, se existir.
function apiDetail(data: unknown): string | null {
  if (data && typeof data === "object" && "detail" in data && typeof data.detail === "string") {
    return data.detail;
  }
  return null;
}

// Converte o status HTTP de uma falha em mensagem amigável.
function describeStatus(status: number, data: unknown, retryAfter: string | null): string {
  if (status === 401) return texts.chat.errors.sessionExpired;
  if (status === 400 && data && typeof data === "object" && "conteudo" in data) {
    return texts.chat.errors.invalidMessage;
  }
  if (status === 400) return texts.chat.errors.badRequest;
  if (status === 403) return apiDetail(data) ?? texts.chat.errors.forbidden;
  if (status === 404) return texts.chat.errors.notFound;
  if (status === 409) return texts.chat.errors.conflict;
  if (status === 429) {
    const seconds = Number.parseInt(retryAfter ?? "", 10);
    return Number.isFinite(seconds) && seconds > 0
      ? texts.chat.errors.tooManyRequestsIn(seconds)
      : texts.chat.errors.tooManyRequests;
  }
  if (status >= 500) return apiDetail(data) ?? texts.chat.errors.unavailable;
  return texts.chat.errors.failed;
}

// Leitor de resposta: devolve o valor com o formato conferido, ou undefined se ele não confere.
type Leitor<T> = (data: unknown) => T | undefined;
// Objeto JSON cujo formato ainda não foi conferido.
type Dados = Record<string, unknown>;

const DESTINATARIOS: readonly Destinatario[] = ["henrique", "assistente"];
const ORIGENS: readonly Origem[] = ["usuario", "henrique", "assistente"];
const LADOS_LEITURA: readonly Leitura["por"][] = ["usuario", "henrique"];

// Confere se o valor é um objeto JSON, sem ser null nem lista.
function isObjeto(value: unknown): value is Dados {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Confere se o valor é um dos valores permitidos.
function isUm<T>(permitidos: readonly T[], value: unknown): value is T {
  return (permitidos as readonly unknown[]).includes(value);
}

// Confere se o valor é um inteiro não negativo, como ids, contagens e marcadores de leitura.
function isInteiro(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

// Confere se o valor é uma data que o navegador consegue interpretar e formatar.
function isData(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

// Confere se o valor é o endereço de outra página ou null.
function isCursor(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

// Confere se o valor é um usuário com id e nome de usuário.
function isUsuario(value: unknown): value is Perfil["usuario"] {
  return isObjeto(value) && isInteiro(value.id) && typeof value.username === "string";
}

// Confere se o valor tem todos os campos que a interface usa para exibir uma mensagem.
export function isMensagem(value: unknown): value is Mensagem {
  return (
    isObjeto(value) &&
    isInteiro(value.id) &&
    typeof value.conversa_id === "string" &&
    isObjeto(value.remetente) &&
    (value.remetente.id === null || isInteiro(value.remetente.id)) &&
    typeof value.remetente.nome === "string" &&
    isUm(ORIGENS, value.origem) &&
    typeof value.conteudo === "string" &&
    typeof value.id_cliente === "string" &&
    isData(value.criada_em)
  );
}

// Lê uma mensagem enviada ou recebida.
const lerMensagem: Leitor<Mensagem> = (value) => (isMensagem(value) ? value : undefined);

// Lê uma conversa; uma última mensagem malformada vira null para a conversa continuar utilizável.
function lerConversa(value: unknown): Conversa | undefined {
  if (
    !isObjeto(value) ||
    typeof value.id !== "string" ||
    !isUsuario(value.usuario) ||
    !isUm(DESTINATARIOS, value.destinatario) ||
    typeof value.nome_destinatario !== "string" ||
    !isData(value.criada_em) ||
    !isData(value.atualizada_em) ||
    !isInteiro(value.nao_lidas) ||
    !isInteiro(value.ultima_lida_usuario) ||
    !isInteiro(value.ultima_lida_henrique)
  ) {
    return undefined;
  }

  return {
    id: value.id,
    usuario: value.usuario,
    destinatario: value.destinatario,
    nome_destinatario: value.nome_destinatario,
    criada_em: value.criada_em,
    atualizada_em: value.atualizada_em,
    nao_lidas: value.nao_lidas,
    ultima_mensagem: isMensagem(value.ultima_mensagem) ? value.ultima_mensagem : null,
    ultima_lida_usuario: value.ultima_lida_usuario,
    ultima_lida_henrique: value.ultima_lida_henrique,
  };
}

// Lê o perfil do usuário; destinatários desconhecidos ou malformados são ignorados.
function lerPerfil(value: unknown): Perfil | undefined {
  if (
    !isObjeto(value) ||
    !isUsuario(value.usuario) ||
    typeof value.operador !== "boolean" ||
    !Array.isArray(value.destinatarios) ||
    typeof value.assistente_ia_ativo !== "boolean" ||
    typeof value.websocket_path !== "string"
  ) {
    return undefined;
  }

  return {
    usuario: value.usuario,
    operador: value.operador,
    destinatarios: value.destinatarios.filter(
      (item: unknown): item is Perfil["destinatarios"][number] =>
        isObjeto(item) && isUm(DESTINATARIOS, item.id) && typeof item.nome === "string",
    ),
    assistente_ia_ativo: value.assistente_ia_ativo,
    websocket_path: value.websocket_path,
  };
}

// Lê a confirmação de leitura devolvida pela API.
function lerLeitura(value: unknown): Leitura | undefined {
  return isObjeto(value) && isUm(LADOS_LEITURA, value.por) && isInteiro(value.mensagem_id)
    ? { por: value.por, mensagem_id: value.mensagem_id }
    : undefined;
}

// Cria o leitor de uma página: confere a paginação e descarta só os itens malformados.
function lerPagina<T>(lerItem: Leitor<T>): Leitor<Pagina<T>> {
  return (value) => {
    if (!isObjeto(value) || !isCursor(value.next) || !isCursor(value.previous) || !Array.isArray(value.results)) {
      return undefined;
    }
    return {
      next: value.next,
      previous: value.previous,
      results: value.results.map(lerItem).filter((item): item is T => item !== undefined),
    };
  };
}

// Opções de uma chamada à API.
type RequestOptions = { method?: "GET" | "POST"; body?: unknown; signal?: AbortSignal };

// Faz a chamada autenticada à API com limite de 15 s e devolve a resposta conferida ou lança ApiError.
async function request<T>(
  token: string,
  path: string,
  ler: Leitor<T>,
  { method = "GET", body, signal }: RequestOptions = {},
): Promise<T> {
  const timeout = AbortSignal.timeout(15000);
  let response: Response;

  try {
    response = await fetch(`${apiUrl}${path}`, {
      method,
      headers: {
        Authorization: `Token ${token}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      credentials: "omit",
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ApiError(0, timeout.aborted ? texts.chat.errors.timeout : texts.chat.errors.offline);
  }

  const data: unknown = response.status === 204 ? null : await response.json().catch(() => null);

  if (!response.ok) {
    throw new ApiError(response.status, describeStatus(response.status, data, response.headers.get("Retry-After")));
  }
  const result = ler(data);
  if (result === undefined) {
    throw new ApiError(response.status, texts.chat.errors.invalidResponse);
  }

  return result;
}

// Reduz a URL da próxima página devolvida pela API a caminho e query.
function relativeUrl(url: string): string {
  const parsed = new URL(url, window.location.href);
  return `${parsed.pathname}${parsed.search}`;
}

// Busca o perfil do usuário logado.
export const getPerfil = (token: string, signal?: AbortSignal) =>
  request(token, "/chat/", lerPerfil, { signal });

// Lista as conversas (50 por página), com filtro por destinatário ou cursor da próxima página.
export function listConversas(
  token: string,
  options: { destinatario?: Destinatario; next?: string | null; signal?: AbortSignal } = {},
) {
  const path = options.next
    ? relativeUrl(options.next)
    : `/chat/conversas/?tamanho=50${options.destinatario ? `&destinatario=${options.destinatario}` : ""}`;
  return request(token, path, lerPagina(lerConversa), { signal: options.signal });
}

// Abre (ou recupera) a conversa do usuário com um destinatário.
export const abrirConversa = (token: string, destinatario: Destinatario, signal?: AbortSignal) =>
  request(token, "/chat/conversas/", lerConversa, { method: "POST", body: { destinatario }, signal });

// Busca uma conversa pelo id.
export const getConversa = (token: string, id: string, signal?: AbortSignal) =>
  request(token, `/chat/conversas/${id}/`, lerConversa, { signal });

// Lista as mensagens de uma conversa, por página ou só as posteriores a um id.
export function getMensagens(
  token: string,
  conversaId: string,
  options: { tamanho?: number; aposId?: number; next?: string | null; signal?: AbortSignal } = {},
) {
  const path = options.next
    ? relativeUrl(options.next)
    : `/chat/conversas/${conversaId}/mensagens/?tamanho=${options.tamanho ?? 30}${
        options.aposId === undefined ? "" : `&apos_id=${options.aposId}`
      }`;
  return request(token, path, lerPagina(lerMensagem), { signal: options.signal });
}

// Envia uma mensagem; o id do cliente evita duplicação em reenvios.
export const enviarMensagem = (
  token: string,
  conversaId: string,
  conteudo: string,
  idCliente: string,
  signal?: AbortSignal,
) =>
  request(token, `/chat/conversas/${conversaId}/mensagens/`, lerMensagem, {
    method: "POST",
    body: { conteudo, id_cliente: idCliente },
    signal,
  });

// Marca a conversa como lida até uma mensagem.
export const marcarLida = (token: string, conversaId: string, mensagemId: number, signal?: AbortSignal) =>
  request(token, `/chat/conversas/${conversaId}/leitura/`, lerLeitura, {
    method: "POST",
    body: { mensagem_id: mensagemId },
    signal,
  });

// Revoga o token no servidor e informa se a sessão terminou; 401 significa que o token já não valia.
export async function encerrarSessao(token: string, signal?: AbortSignal): Promise<boolean> {
  try {
    await request(token, "/logout/", () => null, { method: "POST", signal });
    return true;
  } catch (error) {
    return error instanceof ApiError && error.status === 401;
  }
}

// Monta a URL do WebSocket (ws ou wss) a partir do endereço da API.
export function socketUrl(path: string): string {
  if (/^https?:\/\//i.test(apiUrl)) {
    const base = new URL(apiUrl);
    base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
    base.pathname = `${base.pathname.replace(/\/+$/, "")}${path}`;
    return base.toString();
  }

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}${apiUrl}${path}`;
}

// Gera um UUID v4, com alternativa para navegadores sem crypto.randomUUID.
export function novoUuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();

  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex
    .slice(8, 10)
    .join("")}-${hex.slice(10).join("")}`;
}
