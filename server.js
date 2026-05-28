const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { PDFDocument } = require('pdf-lib');
const pdfParse = require('pdf-parse');
const { Builder } = require('xml2js');
const archiver = require('archiver');

const app = express();
const PORT = 3000;

// ─────────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Log de todas as requisições
app.use((req, res, next) => {
  console.log(`[${new Date().toLocaleTimeString('pt-BR')}] ${req.method} ${req.url}`);
  next();
});

// Criar pastas necessárias
const uploadsDir = path.join(__dirname, 'uploads');
const outputDir = path.join(__dirname, 'output');
[uploadsDir, outputDir].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ─────────────────────────────────────────────
// MULTER — configuração com tratamento de erro
// ─────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    // Sanitiza o nome do arquivo para evitar problemas com caracteres especiais
    const safeName = `${Date.now()}-${Math.round(Math.random() * 1e9)}.pdf`;
    cb(null, safeName);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024, files: 100 }, // 50MB por arquivo, 100 arquivos
  fileFilter: (req, file, cb) => {
    const isPdf =
      file.mimetype === 'application/pdf' ||
      file.mimetype === 'application/octet-stream' ||
      file.originalname.toLowerCase().endsWith('.pdf');
    if (isPdf) {
      cb(null, true);
    } else {
      cb(null, false); // Rejeita silenciosamente (sem lançar erro que quebraria o batch)
    }
  }
});

// Wrapper para tratar erros do multer sem quebrar a requisição
function uploadMiddleware(req, res, next) {
  upload.array('pdfs', 100)(req, res, (err) => {
    if (err) {
      console.error('[MULTER ERROR]', err.message);
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(200).json({
          resultados: [{
            arquivo: 'Arquivo',
            status: 'erro',
            erro: `Arquivo muito grande. Máximo: 50MB por arquivo.`,
            xml: null
          }]
        });
      }
      if (err.code === 'LIMIT_FILE_COUNT') {
        return res.status(200).json({
          resultados: [{
            arquivo: 'Lote',
            status: 'erro',
            erro: 'Limite de 100 arquivos por envio.',
            xml: null
          }]
        });
      }
      return res.status(200).json({
        resultados: [{
          arquivo: 'Envio',
          status: 'erro',
          erro: `Erro no upload: ${err.message}`,
          xml: null
        }]
      });
    }
    next();
  });
}

// ─────────────────────────────────────────────
// ROTA: Processar PDF(s)
// ─────────────────────────────────────────────
app.post('/api/processar', uploadMiddleware, async (req, res) => {
  try {
    console.log(`[PROCESSAR] Arquivos recebidos: ${req.files ? req.files.length : 0}`);

    if (!req.files || req.files.length === 0) {
      return res.status(200).json({
        resultados: [{
          arquivo: 'Desconhecido',
          status: 'erro',
          erro: 'Nenhum arquivo PDF recebido pelo servidor. Verifique se o arquivo tem extensão .pdf',
          xml: null
        }]
      });
    }

    const resultados = [];

    for (const file of req.files) {
      const nomeOriginal = (req.body[`nome_${file.fieldname}`] || file.originalname || 'arquivo.pdf');
      console.log(`[PDF] Processando: ${nomeOriginal} (${(file.size / 1024).toFixed(1)} KB)`);

      try {
        const resultado = await processarPDF(file.path, nomeOriginal);
        console.log(`[PDF] ✓ ${nomeOriginal} → modo: ${resultado.modo}`);
        resultados.push(resultado);
      } catch (err) {
        console.error(`[PDF] ✗ ${nomeOriginal}: ${err.message}`);
        resultados.push({
          arquivo: nomeOriginal,
          status: 'erro',
          erro: err.message,
          xml: null
        });
      } finally {
        try { fs.unlinkSync(file.path); } catch (_) {}
      }
    }

    res.status(200).json({ resultados });

  } catch (err) {
    console.error('[PROCESSAR] Erro geral:', err.message);
    res.status(200).json({
      resultados: [{
        arquivo: 'Desconhecido',
        status: 'erro',
        erro: `Erro interno: ${err.message}`,
        xml: null
      }]
    });
  }
});

// ─────────────────────────────────────────────
// ROTA: Download ZIP
// ─────────────────────────────────────────────
app.post('/api/download-zip', (req, res) => {
  try {
    const { arquivos } = req.body;
    if (!arquivos || arquivos.length === 0) {
      return res.status(400).json({ error: 'Nenhum arquivo para zipar.' });
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename=xmls_nfe.zip');

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (err) => { console.error('[ZIP]', err); });
    archive.pipe(res);

    arquivos.forEach(({ nome, xml }) => {
      const nomeXml = nome.replace(/\.pdf$/i, '.xml');
      archive.append(Buffer.from(xml, 'utf8'), { name: nomeXml });
    });

    archive.finalize();
    console.log(`[ZIP] Gerado com ${arquivos.length} arquivo(s)`);
  } catch (err) {
    console.error('[ZIP] Erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// ROTA: Receber nomes originais dos arquivos
// O frontend envia os nomes junto com os arquivos
// ─────────────────────────────────────────────
app.post('/api/processar-nomes', express.json(), (req, res) => {
  res.json({ ok: true });
});

// ─────────────────────────────────────────────
// FUNÇÃO PRINCIPAL: Processar um PDF
// ─────────────────────────────────────────────
async function processarPDF(filePath, originalName) {
  const buffer = fs.readFileSync(filePath);

  // MODO 1: Tentar extrair XML embutido
  try {
    const xmlEmbutido = await extrairXMLEmbutido(buffer);
    if (xmlEmbutido && xmlEmbutido.trim().length > 50) {
      return {
        arquivo: originalName,
        status: 'sucesso',
        modo: 'xml_embutido',
        mensagem: 'XML extraído diretamente do anexo do PDF.',
        xml: xmlEmbutido,
        dados: parsearDadosXML(xmlEmbutido)
      };
    }
  } catch (e) {
    console.log(`[XML Embutido] Não encontrado: ${e.message}`);
  }

  // MODO 2: Extrair texto e parsear campos
  let textData;
  try {
    textData = await pdfParse(buffer, {
      // Opções para tornar mais tolerante
      max: 0 // sem limite de páginas
    });
  } catch (e) {
    throw new Error(`Não foi possível ler o PDF: ${e.message}. O arquivo pode estar corrompido, protegido por senha ou ser uma imagem escaneada.`);
  }

  const texto = textData.text;

  if (!texto || texto.trim().length < 20) {
    throw new Error('PDF sem texto legível. Pode ser um arquivo escaneado (imagem). Nesse caso, o XML embutido não foi encontrado.');
  }

  const dados = extrairDadosDoTexto(texto);
  const xml = gerarXML(dados, originalName);

  return {
    arquivo: originalName,
    status: 'sucesso',
    modo: 'texto_parseado',
    mensagem: 'XML gerado a partir do texto extraído do DANFE.',
    xml,
    dados
  };
}

// ─────────────────────────────────────────────
// Extrair XML embutido no PDF
// ─────────────────────────────────────────────
async function extrairXMLEmbutido(buffer) {
  // Busca direta por conteúdo XML no buffer do PDF (mais confiável)
  const pdfStr = buffer.toString('latin1');

  // Padrões comuns de XML de NF-e dentro de PDF
  const padroes = [
    { start: '<nfeProc', end: '</nfeProc>' },
    { start: '<NFe xmlns', end: '</NFe>' },
    { start: '<?xml', end: '</nfeProc>' },
    { start: '<?xml', end: '</NFe>' },
  ];

  for (const { start, end } of padroes) {
    const idxStart = pdfStr.indexOf(start);
    const idxEnd = pdfStr.lastIndexOf(end);
    if (idxStart !== -1 && idxEnd !== -1 && idxEnd > idxStart) {
      const xml = pdfStr.substring(idxStart, idxEnd + end.length);
      // Verifica se é XML válido (tem ao menos tags básicas)
      if (xml.includes('CNPJ') || xml.includes('nNF') || xml.includes('emit')) {
        return xml;
      }
    }
  }

  // Tenta via pdf-lib (para PDFs com EmbeddedFiles)
  try {
    const pdfDoc = await PDFDocument.load(buffer, {
      ignoreEncryption: true,
      updateMetadata: false
    });

    const catalog = pdfDoc.catalog;
    if (!catalog) return null;

    // Tenta acessar Names > EmbeddedFiles
    const names = catalog.lookupMaybe(pdfDoc.context.obj('Names'), Object);
    if (names) {
      const embFiles = names.lookupMaybe(pdfDoc.context.obj('EmbeddedFiles'), Object);
      if (embFiles) {
        const namesArr = embFiles.lookupMaybe(pdfDoc.context.obj('Names'), Array);
        if (namesArr) {
          for (let i = 1; i < namesArr.length; i += 2) {
            try {
              const fileSpec = pdfDoc.context.lookup(namesArr[i]);
              if (!fileSpec) continue;
              const ef = fileSpec.lookupMaybe(pdfDoc.context.obj('EF'), Object);
              if (!ef) continue;
              const fStream = ef.lookupMaybe(pdfDoc.context.obj('F'), Object) ||
                              ef.lookupMaybe(pdfDoc.context.obj('UF'), Object);
              if (!fStream) continue;
              const contents = fStream.contents || fStream.getContents?.();
              if (contents) {
                const txt = Buffer.from(contents).toString('utf8');
                if (txt.includes('NFe') || txt.includes('nfeProc')) return txt;
              }
            } catch (_) {}
          }
        }
      }
    }
  } catch (e) {
    // pdf-lib falhou, sem problema
  }

  return null;
}

// ─────────────────────────────────────────────
// Parsear campos de XML já extraído
// ─────────────────────────────────────────────
function parsearDadosXML(xmlStr) {
  const get = (tag) => {
    const m = xmlStr.match(new RegExp(`<${tag}[^>]*>([^<]+)<\\/${tag}>`, 'i'));
    return m ? m[1].trim() : '';
  };
  const getFirst = (...tags) => {
    for (const tag of tags) { const v = get(tag); if (v) return v; }
    return '';
  };
  return {
    chaveAcesso: get('chNFe') || extrairChaveDe44Digitos(xmlStr),
    numero: getFirst('nNF', 'numero'),
    serie: get('serie'),
    dataEmissao: getFirst('dhEmi', 'dEmi'),
    emitente: { cnpj: get('CNPJ'), razaoSocial: get('xNome'), uf: get('UF') },
    destinatario: { cnpj: get('CNPJ'), razaoSocial: get('xNome') },
    valorTotal: getFirst('vNF', 'vTotTrib'),
    naturezaOperacao: get('natOp')
  };
}

// ─────────────────────────────────────────────
// Extrair dados do texto do DANFE
// ─────────────────────────────────────────────
function extrairDadosDoTexto(texto) {
  const dados = {
    chaveAcesso: '', numero: '', serie: '', dataEmissao: '',
    emitente: { cnpj: '', razaoSocial: '', endereco: '', municipio: '', uf: '', cep: '', telefone: '' },
    destinatario: { cnpj: '', cpf: '', razaoSocial: '', endereco: '', municipio: '', uf: '' },
    naturezaOperacao: '', valorProdutos: '', valorFrete: '', valorSeguro: '',
    valorDesconto: '', valorIPI: '', valorICMS: '', valorTotal: '',
    itens: [], informacoesComplementares: ''
  };

  // Chave de acesso (44 dígitos)
  dados.chaveAcesso = extrairChaveDe44Digitos(texto);

  // Número e série
  const nfMatch = texto.match(/N[ºo°\.]\s*(\d{3,9})\s+S[ée]rie\s*:?\s*(\d+)/i) ||
                  texto.match(/N[úu]mero\s*:?\s*(\d+)[\s\S]{0,40}S[ée]rie\s*:?\s*(\d+)/i) ||
                  texto.match(/(\d{3,9})\s*\/\s*(\d{1,3})/);
  if (nfMatch) { dados.numero = nfMatch[1]; dados.serie = nfMatch[2]; }

  // Data de emissão
  const dataMatch = texto.match(/(?:Data|Dt\.?)\s+(?:de\s+)?Emiss[aã]o\s*:?\s*(\d{2}[\/\-\.]\d{2}[\/\-\.]\d{4})/i) ||
                    texto.match(/(\d{2}[\/\-\.]\d{2}[\/\-\.]\d{4})/);
  if (dataMatch) dados.dataEmissao = dataMatch[1];

  // CNPJs (pega os dois primeiros encontrados)
  const cnpjMatches = [...texto.matchAll(/\b(\d{2}[\.\s]?\d{3}[\.\s]?\d{3}[\/\s]?\d{4}[\-\s]?\d{2})\b/g)];
  if (cnpjMatches.length > 0) dados.emitente.cnpj = cnpjMatches[0][1].replace(/[^\d]/g, '');
  if (cnpjMatches.length > 1) dados.destinatario.cnpj = cnpjMatches[1][1].replace(/[^\d]/g, '');

  // CPF destinatário
  const cpfMatch = texto.match(/CPF\s*:?\s*(\d{3}[\.\s]?\d{3}[\.\s]?\d{3}[\-\s]?\d{2})/i);
  if (cpfMatch) dados.destinatario.cpf = cpfMatch[1].replace(/[^\d]/g, '');

  // Natureza da operação
  const natMatch = texto.match(/Natureza\s+da\s+Opera[çc][aã]o\s*:?\s*([^\n\r]{3,80})/i);
  if (natMatch) dados.naturezaOperacao = natMatch[1].trim();

  const extrairValor = (regexes) => {
    for (const regex of regexes) {
      const m = texto.match(regex);
      if (m) return m[1].replace(/\s/g, '');
    }
    return '';
  };

  dados.valorTotal = extrairValor([
    /Valor\s+Total\s*(?:da\s+Nota)?\s*R?\$?\s*([\d\.,]+)/i,
    /TOTAL\s+DA\s+NOTA\s*R?\$?\s*([\d\.,]+)/i,
    /vNF\s*>\s*([\d\.,]+)/i
  ]);
  dados.valorProdutos = extrairValor([/Valor\s+Total\s+dos?\s+Produtos?\s*R?\$?\s*([\d\.,]+)/i]);
  dados.valorFrete    = extrairValor([/(?:Valor\s+do?\s+)?Frete\s*R?\$?\s*([\d\.,]+)/i]);
  dados.valorDesconto = extrairValor([/Desconto\s*R?\$?\s*([\d\.,]+)/i]);
  dados.valorIPI      = extrairValor([/Valor\s+(?:do?\s+)?IPI\s*R?\$?\s*([\d\.,]+)/i]);
  dados.valorICMS     = extrairValor([/Base\s+de\s+C[áa]lculo\s+(?:do?\s+)?ICMS\s*R?\$?\s*([\d\.,]+)/i]);

  const infoMatch = texto.match(/Informa[çc][oõ]es?\s+Complementares?\s*:?\s*([\s\S]{0,500}?)(?:\n\n|$)/i);
  if (infoMatch) dados.informacoesComplementares = infoMatch[1].trim().substring(0, 300);

  return dados;
}

function extrairChaveDe44Digitos(texto) {
  // Chave pode estar espaçada em grupos de 4
  const m = texto.match(/\b(\d{4}\s*\d{4}\s*\d{4}\s*\d{4}\s*\d{4}\s*\d{4}\s*\d{4}\s*\d{4}\s*\d{4}\s*\d{4}\s*\d{4})\b/) ||
            texto.match(/\b(\d{44})\b/);
  return m ? m[1].replace(/\s/g, '') : '';
}

// ─────────────────────────────────────────────
// Gerar XML estruturado
// ─────────────────────────────────────────────
function gerarXML(dados, nomeArquivo) {
  const builder = new Builder({
    xmldec: { version: '1.0', encoding: 'UTF-8' },
    renderOpts: { pretty: true, indent: '  ', newline: '\n' }
  });

  const obj = {
    DadosNFe: {
      $: {
        xmlns: 'http://www.portalfiscal.inf.br/nfe',
        versao: '4.00',
        fonte: 'Extraido_DANFE'
      },
      ArquivoOrigem: nomeArquivo,
      DataExtracao: new Date().toISOString(),
      Identificacao: {
        ChaveAcesso: dados.chaveAcesso || '',
        Numero: dados.numero || '',
        Serie: dados.serie || '',
        DataEmissao: dados.dataEmissao || '',
        NaturezaOperacao: dados.naturezaOperacao || ''
      },
      Emitente: {
        CNPJ: dados.emitente?.cnpj || '',
        RazaoSocial: dados.emitente?.razaoSocial || '',
        Endereco: dados.emitente?.endereco || '',
        Municipio: dados.emitente?.municipio || '',
        UF: dados.emitente?.uf || '',
        CEP: dados.emitente?.cep || '',
        Telefone: dados.emitente?.telefone || ''
      },
      Destinatario: {
        CNPJ: dados.destinatario?.cnpj || '',
        CPF: dados.destinatario?.cpf || '',
        RazaoSocial: dados.destinatario?.razaoSocial || '',
        Endereco: dados.destinatario?.endereco || '',
        Municipio: dados.destinatario?.municipio || '',
        UF: dados.destinatario?.uf || ''
      },
      Totais: {
        ValorProdutos: dados.valorProdutos || '',
        ValorFrete: dados.valorFrete || '',
        ValorSeguro: dados.valorSeguro || '',
        ValorDesconto: dados.valorDesconto || '',
        ValorIPI: dados.valorIPI || '',
        BaseCalculoICMS: dados.valorICMS || '',
        ValorTotal: dados.valorTotal || ''
      },
      InformacoesComplementares: dados.informacoesComplementares || ''
    }
  };

  return builder.buildObject(obj);
}

// ─────────────────────────────────────────────
// HANDLER de erro global do Express
// ─────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[EXPRESS ERROR]', err.message);
  res.status(200).json({
    resultados: [{
      arquivo: 'Desconhecido',
      status: 'erro',
      erro: `Erro no servidor: ${err.message}`,
      xml: null
    }]
  });
});

// ─────────────────────────────────────────────
// Iniciar servidor
// ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅ Extrator XML de NF-e rodando em: http://localhost:${PORT}`);
  console.log(`📂 Uploads temporários: ${uploadsDir}`);
  console.log(`📁 XMLs gerados:        ${outputDir}\n`);
});
