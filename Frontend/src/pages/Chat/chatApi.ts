export const apiUrl = (import.meta.env.VITE_API_URL?.trim() || "/api").replace(/\/+$/, "");

export type Destinatario = "henrique" | "assistente";
export type Origem = "usuario" | "henrique" | "assistente";

export type Mensagem = {
  id: number;
  conversa_id: string;
  remetente: { id: number | null; nome: string };
  origem: Origem;
  conteudo: string;
  id_cliente: string;
  criada_em: string;
};

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

export type Perfil = {
  usuario: { id: number; username: string };
  operador: boolean;
  destinatarios: Array<{ id: Destinatario; nome: string }>;
  assistente_ia_ativo: boolean;
  websocket_path: string;
};

export type Pagina<T> = { next: string | null; previous: string | null; results: T[] };

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

function apiDetail(data: unknown): string | null {
  if (data && typeof data === "object" && "detail" in data && typeof data.detail === "string") {
    return data.detail;
  }
  return null;
}

function describeStatus(status: number, data: unknown, retryAfter: string | null): string {
  if (status === 401) return "Sua sessão expirou. Entre novamente.";
  if (status === 400 && data && typeof data === "object" && "conteudo" in data) {
    return "A mensagem não pode ficar vazia nem passar de 4.000 caracteres.";
  }
  if (status === 400) return "Não foi possível processar a solicitação.";
  if (status === 403) return apiDetail(data) ?? "Ação não permitida.";
  if (status === 404) return "Conversa não encontrada.";
  if (status === 409) return "Esta mensagem já foi enviada com outro conteúdo.";
  if (status === 429) {
    const seconds = Number.parseInt(retryAfter ?? "", 10);
    return Number.isFinite(seconds) && seconds > 0
      ? `Muitas requisições. Tente de novo em ${seconds} s.`
      : "Muitas requisições. Aguarde um instante e tente de novo.";
  }
  if (status >= 500) return apiDetail(data) ?? "O chat está temporariamente indisponível. Tente novamente.";
  return "Não foi possível concluir a solicitação.";
}

type RequestOptions = { method?: "GET" | "POST"; body?: unknown; signal?: AbortSignal };

async function request<T>(
  token: string,
  path: string,
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
    throw new ApiError(0, timeout.aborted ? "O servidor demorou para responder." : "Sem conexão com o servidor.");
  }

  const data: unknown = response.status === 204 ? null : await response.json().catch(() => null);

  if (!response.ok) {
    throw new ApiError(response.status, describeStatus(response.status, data, response.headers.get("Retry-After")));
  }
  if (response.status !== 204 && (data === null || typeof data !== "object")) {
    throw new ApiError(response.status, "O servidor retornou uma resposta inválida.");
  }

  return data as T;
}

function relativeUrl(url: string): string {
  const parsed = new URL(url, window.location.href);
  return `${parsed.pathname}${parsed.search}`;
}

export const getPerfil = (token: string, signal?: AbortSignal) =>
  request<Perfil>(token, "/chat/", { signal });

export function listConversas(
  token: string,
  options: { destinatario?: Destinatario; next?: string | null; signal?: AbortSignal } = {},
) {
  const path = options.next
    ? relativeUrl(options.next)
    : `/chat/conversas/?tamanho=50${options.destinatario ? `&destinatario=${options.destinatario}` : ""}`;
  return request<Pagina<Conversa>>(token, path, { signal: options.signal });
}

export const abrirConversa = (token: string, destinatario: Destinatario, signal?: AbortSignal) =>
  request<Conversa>(token, "/chat/conversas/", { method: "POST", body: { destinatario }, signal });

export const getConversa = (token: string, id: string, signal?: AbortSignal) =>
  request<Conversa>(token, `/chat/conversas/${id}/`, { signal });

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
  return request<Pagina<Mensagem>>(token, path, { signal: options.signal });
}

export const enviarMensagem = (
  token: string,
  conversaId: string,
  conteudo: string,
  idCliente: string,
  signal?: AbortSignal,
) =>
  request<Mensagem>(token, `/chat/conversas/${conversaId}/mensagens/`, {
    method: "POST",
    body: { conteudo, id_cliente: idCliente },
    signal,
  });

export const marcarLida = (token: string, conversaId: string, mensagemId: number, signal?: AbortSignal) =>
  request<{ por: "usuario" | "henrique"; mensagem_id: number }>(
    token,
    `/chat/conversas/${conversaId}/leitura/`,
    { method: "POST", body: { mensagem_id: mensagemId }, signal },
  );

export const encerrarSessao = (token: string, signal?: AbortSignal) =>
  request<null>(token, "/logout/", { method: "POST", signal });

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
