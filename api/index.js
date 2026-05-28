const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { PDFDocument } = require('pdf-lib');
const pdfParse = require('pdf-parse');
const { Builder } = require('xml2js');
const archiver = require('archiver');

const app = express();

// ─────────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Log de requisições
app.use((req, res, next) => {
  console.log(`[${new Date().toLocaleTimeString('pt-BR')}] ${req.method} ${req.url}`);
  next();
});

// ─────────────────────────────────────────────
// MULTER — memória (sem disco, compatível Vercel)
// ─────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 20 }, // 10MB / 20 arquivos no Vercel
  fileFilter: (req, file, cb) => {
    const isPdf =
      file.mimetype === 'application/pdf' ||
      file.mimetype === 'application/octet-stream' ||
      file.originalname.toLowerCase().endsWith('.pdf');
    cb(null, isPdf); // false rejeita silenciosamente
  }
});

function uploadMiddleware(req, res, next) {
  upload.array('pdfs', 20)(req, res, (err) => {
    if (err) {
      console.error('[MULTER ERROR]', err.code, err.message);
      const mensagens = {
        LIMIT_FILE_SIZE: 'Arquivo muito grande. No Vercel o limite é 10MB por arquivo.',
        LIMIT_FILE_COUNT: 'Máximo de 20 arquivos por vez no Vercel.',
      };
      return res.status(200).json({
        resultados: [{
          arquivo: 'Upload',
          status: 'erro',
          erro: mensagens[err.code] || `Erro no upload: ${err.message}`,
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
    if (!req.files || req.files.length === 0) {
      return res.status(200).json({
        resultados: [{
          arquivo: 'Desconhecido',
          status: 'erro',
          erro: 'Nenhum arquivo PDF recebido. Verifique se o arquivo tem extensão .pdf',
          xml: null
        }]
      });
    }

    console.log(`[PROCESSAR] ${req.files.length} arquivo(s) recebido(s)`);
    const resultados = [];

    for (const file of req.files) {
      const nomeOriginal = file.originalname || 'arquivo.pdf';
      console.log(`[PDF] Processando: ${nomeOriginal} (${(file.size / 1024).toFixed(1)} KB)`);

      try {
        // No Vercel usamos file.buffer diretamente (memória)
        const resultado = await processarPDF(file.buffer, nomeOriginal);
        console.log(`[PDF] ✓ ${nomeOriginal} → modo: ${resultado.modo}`);
        resultados.push(resultado);
      } catch (err) {
        console.error(`[PDF] ✗ ${nomeOriginal}: ${err.message}`);
        resultados.push({ arquivo: nomeOriginal, status: 'erro', erro: err.message, xml: null });
      }
    }

    res.status(200).json({ resultados });
  } catch (err) {
    console.error('[PROCESSAR] Erro geral:', err.message);
    res.status(200).json({
      resultados: [{ arquivo: 'Desconhecido', status: 'erro', erro: `Erro interno: ${err.message}`, xml: null }]
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
    archive.on('error', err => console.error('[ZIP]', err));
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
// FUNÇÃO PRINCIPAL: Processar um PDF (via buffer)
// ─────────────────────────────────────────────
async function processarPDF(buffer, originalName) {
  // MODO 1: Tentar extrair XML embutido no PDF
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

  // MODO 2: Extrair texto e parsear campos da NF-e
  let textData;
  try {
    textData = await pdfParse(buffer, { max: 0 });
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
  // Busca direta no conteúdo binário do PDF
  const pdfStr = buffer.toString('latin1');
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
      if (xml.includes('CNPJ') || xml.includes('nNF') || xml.includes('emit')) {
        return xml;
      }
    }
  }

  // Tenta via pdf-lib (EmbeddedFiles)
  try {
    const pdfDoc = await PDFDocument.load(buffer, { ignoreEncryption: true, updateMetadata: false });
    const catalog = pdfDoc.catalog;
    if (!catalog) return null;

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
  } catch (_) {}

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
  const getFirst = (...tags) => { for (const t of tags) { const v = get(t); if (v) return v; } return ''; };
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

  dados.chaveAcesso = extrairChaveDe44Digitos(texto);

  const nfMatch = texto.match(/N[ºo°\.]\s*(\d{3,9})\s+S[ée]rie\s*:?\s*(\d+)/i) ||
                  texto.match(/N[úu]mero\s*:?\s*(\d+)[\s\S]{0,40}S[ée]rie\s*:?\s*(\d+)/i) ||
                  texto.match(/(\d{3,9})\s*\/\s*(\d{1,3})/);
  if (nfMatch) { dados.numero = nfMatch[1]; dados.serie = nfMatch[2]; }

  const dataMatch = texto.match(/(?:Data|Dt\.?)\s+(?:de\s+)?Emiss[aã]o\s*:?\s*(\d{2}[\/\-\.]\d{2}[\/\-\.]\d{4})/i) ||
                    texto.match(/(\d{2}[\/\-\.]\d{2}[\/\-\.]\d{4})/);
  if (dataMatch) dados.dataEmissao = dataMatch[1];

  const cnpjMatches = [...texto.matchAll(/\b(\d{2}[\.\s]?\d{3}[\.\s]?\d{3}[\/\s]?\d{4}[\-\s]?\d{2})\b/g)];
  if (cnpjMatches.length > 0) dados.emitente.cnpj = cnpjMatches[0][1].replace(/[^\d]/g, '');
  if (cnpjMatches.length > 1) dados.destinatario.cnpj = cnpjMatches[1][1].replace(/[^\d]/g, '');

  const cpfMatch = texto.match(/CPF\s*:?\s*(\d{3}[\.\s]?\d{3}[\.\s]?\d{3}[\-\s]?\d{2})/i);
  if (cpfMatch) dados.destinatario.cpf = cpfMatch[1].replace(/[^\d]/g, '');

  const natMatch = texto.match(/Natureza\s+da\s+Opera[çc][aã]o\s*:?\s*([^\n\r]{3,80})/i);
  if (natMatch) dados.naturezaOperacao = natMatch[1].trim();

  const extrairValor = (regexes) => {
    for (const regex of regexes) { const m = texto.match(regex); if (m) return m[1].replace(/\s/g, ''); }
    return '';
  };

  dados.valorTotal    = extrairValor([/Valor\s+Total\s*(?:da\s+Nota)?\s*R?\$?\s*([\d\.,]+)/i, /TOTAL\s+DA\s+NOTA\s*R?\$?\s*([\d\.,]+)/i]);
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
      $: { xmlns: 'http://www.portalfiscal.inf.br/nfe', versao: '4.00', fonte: 'Extraido_DANFE' },
      ArquivoOrigem: nomeArquivo,
      DataExtracao: new Date().toISOString(),
      Identificacao: {
        ChaveAcesso: dados.chaveAcesso || '', Numero: dados.numero || '',
        Serie: dados.serie || '', DataEmissao: dados.dataEmissao || '',
        NaturezaOperacao: dados.naturezaOperacao || ''
      },
      Emitente: {
        CNPJ: dados.emitente?.cnpj || '', RazaoSocial: dados.emitente?.razaoSocial || '',
        Endereco: dados.emitente?.endereco || '', Municipio: dados.emitente?.municipio || '',
        UF: dados.emitente?.uf || '', CEP: dados.emitente?.cep || '', Telefone: dados.emitente?.telefone || ''
      },
      Destinatario: {
        CNPJ: dados.destinatario?.cnpj || '', CPF: dados.destinatario?.cpf || '',
        RazaoSocial: dados.destinatario?.razaoSocial || '', Endereco: dados.destinatario?.endereco || '',
        Municipio: dados.destinatario?.municipio || '', UF: dados.destinatario?.uf || ''
      },
      Totais: {
        ValorProdutos: dados.valorProdutos || '', ValorFrete: dados.valorFrete || '',
        ValorSeguro: dados.valorSeguro || '', ValorDesconto: dados.valorDesconto || '',
        ValorIPI: dados.valorIPI || '', BaseCalculoICMS: dados.valorICMS || '',
        ValorTotal: dados.valorTotal || ''
      },
      InformacoesComplementares: dados.informacoesComplementares || ''
    }
  };
  return builder.buildObject(obj);
}

// ─────────────────────────────────────────────
// HANDLER de erro global
// ─────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[EXPRESS ERROR]', err.message);
  res.status(200).json({
    resultados: [{ arquivo: 'Desconhecido', status: 'erro', erro: `Erro no servidor: ${err.message}`, xml: null }]
  });
});

// ─────────────────────────────────────────────
// Exporta para Vercel (serverless) E roda local
// ─────────────────────────────────────────────
module.exports = app;

// Roda localmente se chamado diretamente
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  // Em modo local, serve os arquivos estáticos também
  const path = require('path');
  const fs = require('fs');
  app.use(require('express').static(path.join(__dirname, '..', 'public')));
  const uploadsDir = path.join(__dirname, '..', 'uploads');
  const outputDir  = path.join(__dirname, '..', 'output');
  [uploadsDir, outputDir].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });
  app.listen(PORT, () => {
    console.log(`\n✅ Extrator XML de NF-e rodando em: http://localhost:${PORT}\n`);
  });
}
