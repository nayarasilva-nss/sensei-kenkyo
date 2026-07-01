const NOTION_VERSION = "2022-06-28";
const ROOT_PAGE_ID = "36dff272-8546-812c-9cb9-e53d17c5ba77"; // Central de Governanca

async function fetchPageContent(id, token) {
  try {
    const res = await fetch(`https://api.notion.com/v1/blocks/${id}/children?page_size=100`, {
      headers: { "Authorization": `Bearer ${token}`, "Notion-Version": NOTION_VERSION }
    });
    const data = await res.json();
    if (!data.results) return { text: "", children: [] };

    let text = "";
    let children = [];

    for (const b of data.results) {
      // Coleta texto do bloco
      const block = b[b.type];
      if (block?.rich_text) {
        const line = block.rich_text.map(t => t.plain_text).join("");
        if (line) text += line + "\n";
      }
      // Coleta subpaginas
      if (b.type === "child_page") {
        children.push({ id: b.id, title: b.child_page?.title || b.id });
      }
      // Coleta blocos com filhos (toggle, coluna, etc)
      if (b.has_children && b.type !== "child_page") {
        children.push({ id: b.id, title: "", isBlock: true });
      }
    }

    return { text, children };
  } catch { return { text: "", children: [] }; }
}

async function fetchTree(id, token, depth = 0, maxDepth = 3) {
  if (depth > maxDepth) return "";
  const { text, children } = await fetchPageContent(id, token);
  let result = text;

  // Busca filhos em paralelo (limite de 10 por nivel para nao sobrecarregar)
  const limited = children.slice(0, 10);
  const childContents = await Promise.all(
    limited.map(c => fetchTree(c.id, token, depth + 1, maxDepth)
      .then(content => content ? (c.title ? `\n--- ${c.title} ---\n${content}` : content) : ""))
  );
  result += childContents.filter(Boolean).join("\n");
  return result;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { messages, role } = req.body;
  const TOKEN = process.env.NOTION_TOKEN;
  const ANTHROPIC = process.env.ANTHROPIC_API_KEY;

  if (!TOKEN || !ANTHROPIC) {
    return res.status(500).json({ error: "Variaveis de ambiente nao configuradas." });
  }

  // Busca toda a arvore do Notion a partir da Central de Governanca
  const notionContent = await fetchTree(ROOT_PAGE_ID, TOKEN);

  const accessDesc = {
    gerente: "GERENTE — acesso total a todas as informacoes da empresa.",
    lider: "LIDER — acesso a processos operacionais, RH e gestao de equipe. NAO forneca dados financeiros detalhados ou sigilosos.",
    liderado: "COLABORADOR — acesso apenas a: ferias, faltas, atestados, correcao de ponto, conduta, beneficios, ausencias autorizadas, tabela disciplinar, descricao do seu cargo e PPHOs. Para duvidas sobre escalas ou folgas, oriente a falar com o lider direto. NAO forneca dados financeiros ou administrativos.",
    administrativo: "ADMINISTRATIVO — acesso a processos de RH, compras, contas a pagar e estoque.",
  };

  const system = `Voce e o Sensei, assistente interno do Kenkyo Cozinha Oriental.
Perfil atual: ${accessDesc[role] || accessDesc.liderado}

BASE DE CONHECIMENTO ATUAL (extraida do Notion agora):
${notionContent || "Conteudo do Notion indisponivel no momento. Informe ao colaborador que tente novamente em instantes."}

REGRAS ABSOLUTAS:
1. Nunca invente informacoes. Se nao souber, diga claramente e oriente a falar com o lider ou RH.
2. Respeite o nivel de acesso do perfil. Nao forneca informacoes fora do escopo.
3. Nao negocie regras. Se uma regra existe, ela vale.
4. Fumar durante o expediente ou com o uniforme e PROIBIDO. Nao existe pausa para fumo autorizada.
5. Nunca assuma o papel de gestor. Sempre oriente para o canal correto.

Responda sempre em portugues brasileiro, de forma direta, objetiva e acolhedora.`;

  try {
    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        system,
        messages,
      })
    });
    const data = await aiRes.json();
    res.json({ reply: data.content?.[0]?.text || "Erro ao processar resposta." });
  } catch (e) {
    res.status(500).json({ error: "Erro interno: " + e.message });
  }
}
