const https = require("https");

const NOTION_VERSION = "2022-06-28";
const ROOT_PAGE_ID = "36dff272-8546-812c-9cb9-e53d17c5ba77";

function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({ hostname, path, method: "POST", headers: { ...headers, "Content-Length": Buffer.byteLength(data) } }, (res) => {
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end", () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function httpsGet(hostname, path, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: "GET", headers }, (res) => {
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end", () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
    });
    req.on("error", reject);
    req.end();
  });
}

async function fetchPage(id, token) {
  try {
    const data = await httpsGet("api.notion.com", `/v1/blocks/${id}/children?page_size=100`, {
      "Authorization": "Bearer " + token,
      "Notion-Version": NOTION_VERSION
    });
    if (!data.results) return { text: "", children: [] };
    let text = "";
    let children = [];
    for (const b of data.results) {
      const block = b[b.type];
      if (block && block.rich_text) {
        const line = block.rich_text.map(t => t.plain_text).join("");
        if (line) text += line + "\n";
      }
      if (b.type === "child_page") {
        children.push({ id: b.id, title: b.child_page ? b.child_page.title : "" });
      } else if (b.has_children && b.type !== "child_page") {
        children.push({ id: b.id, title: "", isBlock: true });
      }
    }
    return { text, children };
  } catch (e) {
    return { text: "", children: [] };
  }
}

async function fetchTree(id, token, depth) {
  if (depth > 3) return "";
  const { text, children } = await fetchPage(id, token);
  let result = text;
  const limited = children.slice(0, 10);
  for (const c of limited) {
    const content = await fetchTree(c.id, token, depth + 1);
    if (content) result += (c.title ? "\n--- " + c.title + " ---\n" : "\n") + content;
  }
  return result;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { messages, role } = req.body;
  const TOKEN = process.env.NOTION_TOKEN;
  const ANTHROPIC = process.env.ANTHROPIC_API_KEY;

  if (!TOKEN || !ANTHROPIC) {
    res.status(500).json({ error: "Variaveis de ambiente nao configuradas." });
    return;
  }

  const notionContent = await fetchTree(ROOT_PAGE_ID, TOKEN, 0);

  const accessDesc = {
    gerente: "GERENTE - acesso total a todas as informacoes da empresa.",
    lider: "LIDER - acesso a processos operacionais, RH e gestao de equipe. NAO forneca dados financeiros detalhados.",
    liderado: "COLABORADOR - acesso apenas a: ferias, faltas, atestados, correcao de ponto, conduta, beneficios, ausencias autorizadas, tabela disciplinar, descricao do seu cargo e PPHOs. Para duvidas sobre escalas ou folgas, oriente a falar com o lider direto.",
    administrativo: "ADMINISTRATIVO - acesso a processos de RH, compras, contas a pagar e estoque.",
  };

  const system = "Voce e o Sensei, assistente interno do Kenkyo Cozinha Oriental.\n" +
    "Perfil atual: " + (accessDesc[role] || accessDesc.liderado) + "\n\n" +
    "BASE DE CONHECIMENTO ATUAL (extraida do Notion agora):\n" +
    (notionContent || "Conteudo do Notion indisponivel no momento.") + "\n\n" +
    "REGRAS ABSOLUTAS:\n" +
    "1. Nunca invente informacoes. Se nao souber, diga claramente e oriente a falar com o lider ou RH.\n" +
    "2. Respeite o nivel de acesso do perfil.\n" +
    "3. Nao negocie regras. Se uma regra existe, ela vale.\n" +
    "4. Fumar durante o expediente ou com o uniforme e PROIBIDO.\n" +
    "5. Nunca assuma o papel de gestor. Sempre oriente para o canal correto.\n" +
    "Responda sempre em portugues brasileiro, de forma direta, objetiva e acolhedora.";

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

    const reply = aiData.content && aiData.content[0] ? aiData.content[0].text : "Erro ao processar resposta.";
    res.status(200).json({ reply });
  } catch (e) {
    res.status(500).json({ error: "Erro interno: " + e.message });
  }
};
