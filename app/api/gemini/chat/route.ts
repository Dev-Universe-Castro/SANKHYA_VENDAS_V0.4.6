
import { NextRequest } from 'next/server';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { cookies } from 'next/headers';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

// Função para enriquecer um lead com todos os dados relacionados
async function enriquecerLead(lead: any, baseUrl: string, funis: any[], estagiosPorFunil: Record<string, any[]>, parceiros: any[], userId: number) {
  try {
    // Buscar funil e estágio
    const funil = funis.find((f: any) => f.CODFUNIL === lead.CODFUNIL);
    const estagios = estagiosPorFunil[lead.CODFUNIL] || [];
    const estagio = estagios.find((e: any) => e.CODESTAGIO === lead.CODESTAGIO);

    // Buscar parceiro
    const parceiro = parceiros.find((p: any) => p.CODPARC === lead.CODPARC);

    // Headers com autenticação
    const headers = {
      'Cookie': `user=${JSON.stringify({ id: userId })}`
    };

    // Buscar atividades do lead
    const atividadesResponse = await fetch(`${baseUrl}/api/leads/atividades?codLead=${lead.CODLEAD}`, { headers });
    const atividades = atividadesResponse.ok ? await atividadesResponse.json() : [];

    // Buscar produtos do lead
    const produtosResponse = await fetch(`${baseUrl}/api/leads/produtos?codLead=${lead.CODLEAD}`, { headers });
    const produtosLead = produtosResponse.ok ? await produtosResponse.json() : [];

    // Buscar pedidos do parceiro (se houver)
    let pedidosParceiro = [];
    if (parceiro?.CODPARC) {
      const pedidosResponse = await fetch(`${baseUrl}/api/sankhya/pedidos/listar?codParc=${parceiro.CODPARC}&userId=${userId}`, { headers });
      pedidosParceiro = pedidosResponse.ok ? await pedidosResponse.json() : [];
    }

    // Última interação
    const atividadesOrdenadas = [...atividades].sort((a, b) => 
      new Date(b.DATA_HORA).getTime() - new Date(a.DATA_HORA).getTime()
    );
    const ultimaAtividade = atividadesOrdenadas[0];

    return {
      ...lead,
      // Funil e estágio
      NOME_FUNIL: funil?.NOME || 'Funil Desconhecido',
      COR_FUNIL: funil?.COR || '#gray',
      NOME_ESTAGIO: estagio?.NOME || 'Estágio Desconhecido',
      ORDEM_ESTAGIO: estagio?.ORDEM || 0,
      COR_ESTAGIO: estagio?.COR || '#gray',
      ESTAGIOS_FUNIL: estagios.map((e: any) => ({
        nome: e.NOME,
        ordem: e.ORDEM,
        cor: e.COR
      })),
      // Parceiro
      PARCEIRO: parceiro ? {
        codigo: parceiro.CODPARC,
        nome: parceiro.NOMEPARC,
        documento: parceiro.CGC_CPF,
        cidade: parceiro.NOMECID,
        ativo: parceiro.ATIVO
      } : null,
      // Produtos vinculados
      PRODUTOS: produtosLead.filter((p: any) => p.ATIVO === 'S').map((p: any) => ({
        codigo: p.CODPROD,
        descricao: p.DESCRPROD,
        quantidade: p.QUANTIDADE,
        valorUnitario: p.VLRUNIT,
        valorTotal: p.VLRTOTAL
      })),
      // Atividades
      ATIVIDADES: atividades.map((a: any) => ({
        tipo: a.TIPO,
        descricao: a.DESCRICAO,
        dataHora: a.DATA_HORA,
        status: a.STATUS,
        cor: a.COR
      })),
      // Última interação
      ULTIMA_INTERACAO: ultimaAtividade ? {
        data: ultimaAtividade.DATA_HORA,
        tipo: ultimaAtividade.TIPO,
        descricao: ultimaAtividade.DESCRICAO
      } : null,
      // Pedidos do parceiro
      PEDIDOS_PARCEIRO: pedidosParceiro.slice(0, 5).map((p: any) => ({
        nunota: p.NUNOTA,
        valor: p.VLRNOTA,
        data: p.DTNEG,
        vendedor: p.NOMEVEND
      }))
    };
  } catch (error) {
    console.error(`Erro ao enriquecer lead ${lead.CODLEAD}:`, error);
    return lead;
  }
}

// Função para buscar dados do sistema
async function analisarDadosDoSistema(userId: number, userName: string, leadContextCodLead?: string) {
  try {
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:5000';
    const headers = { 'Cookie': `user=${JSON.stringify({ id: userId })}` };
    
    console.log('⚡ Iniciando busca paralela de dados...');
    
    // **PARALELIZAÇÃO: Buscar todos os dados simultaneamente**
    const [leadsData, funisData, parceirosData, produtosData, pedidosData] = await Promise.all([
      fetch(`${baseUrl}/api/leads`, { headers }).then(r => r.ok ? r.json() : []),
      fetch(`${baseUrl}/api/funis`, { headers }).then(r => r.ok ? r.json() : []),
      fetch(`${baseUrl}/api/sankhya/parceiros?page=1&pageSize=100`).then(r => r.ok ? r.json() : { parceiros: [] }),
      fetch(`${baseUrl}/api/sankhya/produtos?page=1&pageSize=100`).then(r => r.ok ? r.json() : { produtos: [] }),
      fetch(`${baseUrl}/api/sankhya/pedidos/listar?userId=${userId}`).then(r => r.ok ? r.json() : [])
    ]);

    const leads = Array.isArray(leadsData) ? leadsData : [];
    const funis = Array.isArray(funisData) ? funisData : [];
    const parceiros = Array.isArray(parceirosData.parceiros) ? parceirosData.parceiros : [];
    const produtos = Array.isArray(produtosData.produtos) ? produtosData.produtos : [];
    const pedidos = Array.isArray(pedidosData) ? pedidosData : [];

    // Buscar estágios de todos os funis em paralelo
    const estagiosPorFunil: Record<string, any[]> = {};
    const estagiosPromises = funis.map(async (funil) => {
      const estagiosData = await fetch(`${baseUrl}/api/funis/estagios?codFunil=${funil.CODFUNIL}`, { headers })
        .then(r => r.ok ? r.json() : []);
      estagiosPorFunil[funil.CODFUNIL] = Array.isArray(estagiosData) ? estagiosData : [];
    });
    await Promise.all(estagiosPromises);

    console.log(`✅ Dados carregados: ${leads.length} leads, ${funis.length} funis, ${produtos.length} produtos`);

    // **ENRIQUECER LEADS: Limitar a 10 e remover lead do contexto se existir**
    let leadsParaEnriquecer = leads.slice(0, 10);
    
    // Se há um lead aberto no contexto, removê-lo da lista geral para evitar duplicação
    if (leadContextCodLead) {
      leadsParaEnriquecer = leadsParaEnriquecer.filter(l => l.CODLEAD !== leadContextCodLead);
      console.log(`🔍 Lead ${leadContextCodLead} removido da lista geral (já está no contexto)`);
    }

    const leadsEnriquecidos = await Promise.all(
      leadsParaEnriquecer.map(lead => enriquecerLead(lead, baseUrl, funis, estagiosPorFunil, parceiros, userId))
    );
    console.log(`✅ ${leadsEnriquecidos.length} leads enriquecidos`);

    return {
      userName,
      leads: leadsEnriquecidos,
      funis: funis,
      estagiosPorFunil: estagiosPorFunil,
      parceiros: parceiros.slice(0, 15),
      produtos: produtos.slice(0, 15),
      pedidos: pedidos.slice(0, 10),
      totalLeads: leads.length,
      totalParceiros: parceirosData.total || parceiros.length,
      totalProdutos: produtosData.total || produtos.length,
      totalPedidos: pedidos.length
    };
  } catch (error) {
    console.error('Erro ao analisar dados:', error);
    return null;
  }
}

const SYSTEM_PROMPT = `Você é um Assistente de Vendas Inteligente integrado em uma ferramenta de CRM/Força de Vendas chamada Sankhya CRM.

SEU PAPEL E RESPONSABILIDADES:
- Ajudar vendedores a identificar oportunidades de vendas
- Sugerir ações estratégicas para fechar negócios
- Analisar leads e recomendar próximos passos
- Identificar clientes potenciais com maior chance de conversão
- Sugerir produtos que podem interessar aos clientes
- Alertar sobre leads em risco ou oportunidades urgentes

DADOS QUE VOCÊ TEM ACESSO:
- Leads: oportunidades de vendas com informações sobre valor, estágio, parceiro associado
- Parceiros: clientes e prospects cadastrados no sistema
- Produtos: catálogo REAL de produtos com estoque atual (USE APENAS OS PRODUTOS FORNECIDOS NO CONTEXTO)
- Atividades: histórico de interações com leads
- Lead Atual: quando um lead específico estiver aberto, você terá acesso completo aos seus dados detalhados (funil, estágio, valor, produtos, atividades, parceiro, última interação)

⚠️ REGRA IMPORTANTE SOBRE PRODUTOS:
Você receberá uma lista completa de produtos com suas quantidades em estoque.
NUNCA mencione produtos que não estejam explicitamente listados nos dados fornecidos.
Se não houver produtos na lista, informe que não há produtos cadastrados no momento.

COMO VOCÊ DEVE AGIR:
1. Sempre analise os dados fornecidos antes de responder
2. Seja proativo em sugerir vendas e ações comerciais
3. Identifique padrões e oportunidades nos dados
4. Use métricas e números concretos em suas análises
5. Seja direto e focado em resultados de vendas
6. Priorize leads com maior valor e urgência
7. Sugira próximos passos claros e acionáveis
8. Quando um lead específico estiver aberto, você DEVE responder APENAS com base nas informações daquele lead
9. Use TODAS as informações do contexto do lead: nome do funil, estágios, parceiro, produtos, atividades e última interação
10. NUNCA invente ou assuma informações que não estão explicitamente no contexto fornecido

FORMATO DAS RESPOSTAS:
- Use emojis para destacar informações importantes (📊 💰 🎯 ⚠️ ✅)
- Organize informações em listas quando relevante
- Destaque valores monetários e datas importantes
- Seja conciso mas informativo

Sempre que o usuário fizer uma pergunta, considere os dados do sistema disponíveis para dar respostas contextualizadas e acionáveis.`;

export async function POST(request: NextRequest) {
  try {
    const { message, history, leadContext } = await request.json();

    // Obter usuário autenticado
    const cookieStore = await cookies();
    const userCookie = cookieStore.get('user');
    let userId = 0;
    let userName = 'Usuário';
    
    if (userCookie) {
      try {
        const user = JSON.parse(userCookie.value);
        userId = user.id;
        userName = user.name || 'Usuário';
      } catch (e) {
        console.error('Erro ao parsear cookie:', e);
      }
    }

    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    // Montar histórico com prompt de sistema
    const chatHistory = [
      {
        role: 'user',
        parts: [{ text: SYSTEM_PROMPT }],
      },
      {
        role: 'model',
        parts: [{ text: 'Entendido! Sou seu Assistente de Vendas no Sankhya CRM. Estou pronto para analisar seus dados e ajudar você a vender mais. Como posso ajudar?' }],
      },
      ...history.map((msg: any) => ({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content }],
      }))
    ];

    // Adicionar contexto de dados APENAS no primeiro prompt do usuário
    let messageWithContext = message;
    if (history.length === 0) {
      console.log('🔍 Primeiro prompt detectado - Buscando dados do sistema...');
      
      // Extrair CODLEAD do leadContext se disponível
      let leadContextCodLead: string | undefined;
      if (leadContext) {
        const match = leadContext.match(/ID do Lead:\s*(\d+)/);
        leadContextCodLead = match ? match[1] : undefined;
      }
      
      const dadosSistema = await analisarDadosDoSistema(userId, userName, leadContextCodLead);
      
      if (dadosSistema) {
        let leadContextoFormatado = '';
        
        // Adicionar contexto do lead se disponível
        if (leadContext) {
          console.log('📋 Lead aberto - Adicionando contexto prioritário');
          leadContextoFormatado = `
🎯 LEAD ABERTO (PRIORIDADE):
${leadContext}
---
`;
        }
        
        // **FORMATAÇÃO OTIMIZADA E CONCISA**
        messageWithContext = `${leadContextoFormatado}
📊 RESUMO: ${dadosSistema.totalLeads} leads | ${dadosSistema.totalParceiros} clientes | ${dadosSistema.totalProdutos} produtos | ${dadosSistema.totalPedidos} pedidos

🎯 LEADS PRINCIPAIS (${dadosSistema.leads.length}):
${dadosSistema.leads.map(l => `
• ${l.NOME} (ID: ${l.CODLEAD}) | 💰 R$ ${l.VALOR?.toLocaleString('pt-BR') || '0'}
  ↳ ${l.NOME_FUNIL} → ${l.NOME_ESTAGIO} | Venc: ${l.DATA_VENCIMENTO || 'N/A'}
  ${l.PARCEIRO ? `Cliente: ${l.PARCEIRO.nome}` : 'Sem cliente'}
  ${l.PRODUTOS?.length > 0 ? `Produtos: ${l.PRODUTOS.map(p => `${p.descricao} (${p.quantidade}x)`).join(', ')}` : 'Sem produtos'}
  ${l.ULTIMA_INTERACAO ? `Última: ${l.ULTIMA_INTERACAO.tipo} em ${new Date(l.ULTIMA_INTERACAO.data).toLocaleDateString('pt-BR')}` : 'Sem interação'}`
).join('\n')}

📦 PRODUTOS (${dadosSistema.produtos.length}):
${dadosSistema.produtos.map(p => `• ${p.DESCRPROD} | Estoque: ${parseFloat(p.ESTOQUE || '0').toFixed(0)} un`).join('\n')}

PERGUNTA: ${message}`;
        console.log('✅ Prompt otimizado gerado');
      }
    } else {
      console.log('💬 Prompt subsequente');
    }

    const chat = model.startChat({
      history: chatHistory,
      generationConfig: {
        maxOutputTokens: 1024, // Reduzido para respostas mais diretas e acionáveis
      },
    });

    // Usar streaming com contexto
    const result = await chat.sendMessageStream(messageWithContext);

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          for await (const chunk of result.stream) {
            const text = chunk.text();
            const data = `data: ${JSON.stringify({ text })}\n\n`;
            controller.enqueue(encoder.encode(data));
          }
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  } catch (error) {
    console.error('Erro no chat Gemini:', error);
    return new Response(JSON.stringify({ error: 'Erro ao processar mensagem' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
