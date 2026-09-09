import https from "node:https";
import crypto from "node:crypto";

const NOTION_VERSION = "2022-06-28";
const ROOT_PAGE_ID = "36dff272-8546-812c-9cb9-e53d17c5ba77";

const SESSION_TTL_MS = 4 * 60 * 60 * 1000; // 4 horas
const NOTION_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos

// Cache em memoria da instancia da funcao. Reduz buscas repetidas ao Notion
// enquanto a instancia estiver quente, mas nao e compartilhado entre
// instancias/regioes diferentes (limitacao do modelo serverless).
let notionCache = { content: null, fetchedAt: 0 };

async function getNotionContent(token) {
  const now = Date.now();
  if (notionCache.content && now - notionCache.fetchedAt < NOTION_CACHE_TTL_MS) {
    return notionCache.content;
  }
  const content = await fetchTree(ROOT_PAGE_ID, token);
  notionCache = { content, fetchedAt: now };
  return content;
}

const PINS = {
  gerente: process.env.PIN_GERENTE,
  lider: process.env.PIN_LIDER,
  liderado: process.env.PIN_LIDERADO,
  administrativo: process.env.PIN_ADMINISTRATIVO,
};

function sign(payload) {
  const secret = process.env.SESSION_SECRET;
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function verifyToken(token) {
  const secret = process.env.SESSION_SECRET;
  if (!token || !secret) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!payload.role || !payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function httpsGet(path, token) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: "api.notion.com",
      path,
      method: "GET",
      headers: {
        "Authorization": "Bearer " + token,
        "Notion-Version": NOTION_VERSION
      }
    }, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch { resolve({}); }
      });
    });
    req.on("error", () => resolve({}));
    req.end();
  });
}

function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body), "utf8");
    const req = https.request({
      hostname, path, method: "POST",
      headers: { ...headers, "Content-Length": data.length }
    }, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch { resolve({}); }
      });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

async function fetchPage(id, token) {
  try {
    const data = await httpsGet(`/v1/blocks/${id}/children?page_size=100`, token);
    if (!data.results) return { text: "", children: [] };
    let text = "";
    let children = [];

    for (const b of data.results) {
      const type = b.type;
      const block = b[type];

      // Texto normal
      if (block?.rich_text) {
        const line = block.rich_text.map(t => t.plain_text).join("");
        if (line) text += line + "\n";
      }

      // Tabelas: busca filhos (table_row) separadamente
      if (type === "table") {
        try {
          const tableData = await httpsGet(`/v1/blocks/${b.id}/children?page_size=100`, token);
          if (tableData.results) {
            for (const row of tableData.results) {
              if (row.type === "table_row") {
                const cells = row.table_row?.cells || [];
                const rowText = cells.map(cell => cell.map(t => t.plain_text).join("")).join(" | ");
                if (rowText) text += rowText + "\n";
              }
            }
          }
        } catch {}
        continue;
      }

      // Subpaginas e blocos com filhos
      if (type === "child_page") {
        children.push({ id: b.id, title: b.child_page?.title || "" });
      } else if (b.has_children && type !== "child_page") {
        children.push({ id: b.id, title: "" });
      }
    }
    return { text, children };
  } catch { return { text: "", children: [] }; }
}

async function fetchTree(id, token, depth = 0) {
  if (depth > 3) return "";
  const { text, children } = await fetchPage(id, token);
  let result = text;
  const limited = children.slice(0, depth < 2 ? 10 : 5);
  const childContents = await Promise.all(
    limited.map(c => fetchTree(c.id, token, depth + 1)
      .then(content => content ? (c.title ? `\n--- ${c.title} ---\n${content}` : content) : ""))
  );
  result += childContents.filter(Boolean).join("\n");
  return result;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  if (!process.env.SESSION_SECRET) {
    return res.status(500).json({ error: "SESSION_SECRET nao configurado." });
  }

  const body = req.body || {};

  // Etapa de login: verifica PIN no servidor e devolve um token assinado.
  if (body.action === "login") {
    const { role, pin } = body;
    const expected = PINS[role];
    if (!expected || typeof pin !== "string" || pin.length !== 4 || !PINS.hasOwnProperty(role)) {
      return res.status(401).json({ error: "Cargo ou senha invalidos." });
    }
    const a = Buffer.from(pin);
    const b = Buffer.from(expected);
    const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!ok) return res.status(401).json({ error: "Senha incorreta." });

    const token = sign({ role, exp: Date.now() + SESSION_TTL_MS });
    return res.status(200).json({ token, role });
  }

  // Etapa de chat: exige um token de sessao valido emitido no login.
  const authHeader = req.headers["authorization"] || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const session = verifyToken(token);
  if (!session) {
    return res.status(401).json({ error: "Sessao invalida ou expirada. Faca login novamente." });
  }
  const role = session.role;
  const { messages } = body;
  if (!Array.isArray(messages)) {
    return res.status(400).json({ error: "Mensagens invalidas." });
  }

  const TOKEN = process.env.NOTION_TOKEN;
  const ANTHROPIC = process.env.ANTHROPIC_API_KEY;

  if (!TOKEN || !ANTHROPIC) {
    return res.status(500).json({ error: "Variaveis de ambiente nao configuradas." });
  }

  const notionContent = await getNotionContent(TOKEN);

  const accessDesc = {
    gerente: "GERENTE - acesso total a todas as informacoes da empresa.",
    lider: "LIDER - acesso a processos operacionais, RH e gestao de equipe. NAO forneca dados financeiros detalhados.",
    liderado: "COLABORADOR - acesso apenas a: ferias, faltas, atestados, correcao de ponto, conduta, beneficios, ausencias autorizadas, tabela disciplinar, descricao do seu cargo e PPHOs. Para duvidas sobre escalas ou folgas, fale com o lider direto.",
    administrativo: "ADMINISTRATIVO - acesso a processos de RH, compras, contas a pagar e estoque.",
  };

  const system = `Voce e o Sensei, assistente interno do Kenkyo Cozinha Oriental.
Perfil atual: ${accessDesc[role] || accessDesc.liderado}

BASE DE CONHECIMENTO (extraida do Notion agora):
${notionContent || "Conteudo do Notion indisponivel no momento."}

REGRAS:
1. Nunca invente informacoes. Se nao souber, oriente a falar com o lider ou RH.
2. Respeite o nivel de acesso do perfil.
3. Nao negocie regras.
4. Fumar durante o expediente ou com o uniforme e PROIBIDO.
5. Nunca assuma o papel de gestor.
Responda sempre em portugues brasileiro, de forma direta e acolhedora.`;

  try {
    const aiData = await httpsPost("api.anthropic.com", "/v1/messages", {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC,
      "anthropic-version": "2023-06-01"
    }, {
      model: "claude-sonnet-4-5",
      max_tokens: 1000,
      system,
      messages
    });

    console.log("AI RAW:", JSON.stringify(aiData).slice(0, 500));

    if (aiData.error) {
      console.error("AI ERROR:", JSON.stringify(aiData.error));
      return res.status(500).json({ error: "Erro da IA: " + aiData.error.message });
    }

    const reply = aiData.content?.[0]?.text || "Erro ao processar resposta.";
    return res.status(200).json({ reply });
  } catch (e) {
    console.error("ERRO CATCH:", e.message, e.stack);
    return res.status(500).json({ error: "Erro interno: " + e.message });
  }
}
