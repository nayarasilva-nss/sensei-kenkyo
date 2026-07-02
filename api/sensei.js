import https from "node:https";

const NOTION_VERSION = "2022-06-28";
const ROOT_PAGE_ID = "36dff272-8546-812c-9cb9-e53d17c5ba77";

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
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end", () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
    });
    req.on("error", () => resolve({}));
    req.end();
  });
}

function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname, path, method: "POST",
      headers: { ...headers, "Content-Length": Buffer.byteLength(data) }
    }, (res) => {
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end", () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
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
      const block = b[b.type];
      if (block?.rich_text) {
        const line = block.rich_text.map(t => t.plain_text).join("");
        if (line) text += line + "\n";
      }
      if (b.type === "child_page") {
        children.push({ id: b.id, title: b.child_page?.title || "" });
      } else if (b.has_children) {
        children.push({ id: b.id, title: "" });
      }
    }
    return { text, children };
  } catch { return { text: "", children: [] }; }
}

async function fetchTree(id, token, depth = 0) {
  if (depth > 2) return "";
  const { text, children } = await fetchPage(id, token);
  let result = text;
  const limited = children.slice(0, 5);
  const childContents = await Promise.all(
    limited.map(c => fetchTree(c.id, token, depth + 1)
      .then(content => content ? (c.title ? `\n--- ${c.title} ---\n${content}` : content) : ""))
  );
  result += childContents.filter(Boolean).join("\n");
  return result;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { messages, role } = req.body;
  const TOKEN = process.env.NOTION_TOKEN;
  const ANTHROPIC = process.env.ANTHROPIC_API_KEY;

  if (!TOKEN || !ANTHROPIC) {
    return res.status(500).json({ error: "Variaveis de ambiente nao configuradas." });
  }

  const notionContent = await fetchTree(ROOT_PAGE_ID, TOKEN);

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
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      system,
      messages
    });

    const reply = aiData.content?.[0]?.text || "Erro ao processar resposta.";
    res.status(200).json({ reply });
  } catch (e) {
    res.status(500).json({ error: "Erro interno: " + e.message });
  }
}
