// ─────────────────────────────────────────────
// ESTADO GLOBAL
// ─────────────────────────────────────────────
const state = {
  files: [],       // { id, file, status: 'waiting'|'processing'|'done'|'error' }
  results: [],     // resultados do servidor
  currentXml: '',
  currentXmlName: ''
};

// ─────────────────────────────────────────────
// ELEMENTOS
// ─────────────────────────────────────────────
const dropZone       = document.getElementById('drop-zone');
const fileInput      = document.getElementById('file-input');
const folderInput    = document.getElementById('folder-input');
const btnSelectFiles = document.getElementById('btn-select-files');
const btnSelectFolder= document.getElementById('btn-select-folder');
const btnProcessar   = document.getElementById('btn-processar');
const btnClearQueue  = document.getElementById('btn-clear-queue');
const btnDownloadZip = document.getElementById('btn-download-zip');
const queueSection   = document.getElementById('queue-section');
const fileList       = document.getElementById('file-list');
const queueCount     = document.getElementById('queue-count');
const resultsSection = document.getElementById('results-section');
const resultsBody    = document.getElementById('results-body');
const resultsSummary = document.getElementById('results-summary');
const statsBar       = document.getElementById('stats-bar');
const xmlModal       = document.getElementById('xml-modal');
const xmlContent     = document.getElementById('xml-content');
const modalTitle     = document.getElementById('modal-title');
const btnCopyXml     = document.getElementById('btn-copy-xml');
const btnDownloadXml = document.getElementById('btn-download-xml');
const btnCloseModal  = document.getElementById('btn-close-modal');

// Toast container
const toastContainer = document.createElement('div');
toastContainer.className = 'toast-container';
document.body.appendChild(toastContainer);

// ─────────────────────────────────────────────
// DRAG & DROP
// ─────────────────────────────────────────────
['dragenter','dragover'].forEach(evt => {
  dropZone.addEventListener(evt, e => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });
});
['dragleave','drop'].forEach(evt => {
  dropZone.addEventListener(evt, e => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
  });
});
dropZone.addEventListener('drop', e => {
  const dropped = Array.from(e.dataTransfer.files).filter(f => f.name.toLowerCase().endsWith('.pdf'));
  if (dropped.length === 0) { showToast('Nenhum PDF encontrado nos arquivos arrastados.', 'error'); return; }
  adicionarArquivos(dropped);
});

// Clique na zona
dropZone.addEventListener('click', e => {
  if (e.target.closest('.btn')) return;
  fileInput.click();
});

btnSelectFiles.addEventListener('click', e => { e.stopPropagation(); fileInput.click(); });
btnSelectFolder.addEventListener('click', e => { e.stopPropagation(); folderInput.click(); });
fileInput.addEventListener('change', () => adicionarArquivos(Array.from(fileInput.files)));
folderInput.addEventListener('change', () => {
  const pdfs = Array.from(folderInput.files).filter(f => f.name.toLowerCase().endsWith('.pdf'));
  adicionarArquivos(pdfs);
});

// ─────────────────────────────────────────────
// GERENCIAMENTO DA FILA
// ─────────────────────────────────────────────
function adicionarArquivos(files) {
  const novos = files.filter(f => !state.files.find(sf => sf.file.name === f.name && sf.file.size === f.size));
  if (novos.length === 0) { showToast('Arquivos já estão na fila.', 'info'); return; }

  novos.forEach(f => {
    state.files.push({ id: gerarId(), file: f, status: 'waiting' });
  });

  renderizarFila();
  showToast(`${novos.length} arquivo(s) adicionado(s) à fila.`, 'success');
}

function renderizarFila() {
  const total = state.files.length;
  queueSection.style.display = total > 0 ? 'block' : 'none';
  queueCount.textContent = `${total} arquivo(s)`;

  fileList.innerHTML = '';
  state.files.forEach(item => {
    const div = document.createElement('div');
    div.className = 'file-item';
    div.id = `file-item-${item.id}`;
    div.innerHTML = `
      <div class="file-icon">PDF</div>
      <div class="file-info">
        <div class="file-name" title="${escHtml(item.file.name)}">${escHtml(item.file.name)}</div>
        <div class="file-size">${formatarTamanho(item.file.size)}</div>
      </div>
      <span class="file-status ${statusClass(item.status)}">${statusLabel(item.status)}</span>
      ${item.status === 'waiting' ? `<button class="file-remove" data-id="${item.id}" title="Remover">✕</button>` : ''}
    `;
    fileList.appendChild(div);
  });

  // Listeners de remoção
  fileList.querySelectorAll('.file-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      state.files = state.files.filter(f => f.id !== id);
      renderizarFila();
    });
  });
}

btnClearQueue.addEventListener('click', () => {
  state.files = state.files.filter(f => f.status === 'processing');
  renderizarFila();
});

// ─────────────────────────────────────────────
// PROCESSAMENTO
// ─────────────────────────────────────────────
btnProcessar.addEventListener('click', processar);

async function processar() {
  const emEspera = state.files.filter(f => f.status === 'waiting');
  if (emEspera.length === 0) { showToast('Nenhum arquivo aguardando processamento.', 'info'); return; }

  btnProcessar.disabled = true;
  btnProcessar.innerHTML = `<span class="spinner"></span> Processando...`;

  // Adiciona barra de progresso
  let progressWrapper = document.getElementById('progress-wrapper');
  if (!progressWrapper) {
    progressWrapper = document.createElement('div');
    progressWrapper.id = 'progress-wrapper';
    progressWrapper.className = 'progress-wrapper';
    progressWrapper.innerHTML = '<div class="progress-bar" id="progress-bar"></div>';
    queueSection.appendChild(progressWrapper);
  }
  const progressBar = document.getElementById('progress-bar');

  // Marca todos como processando
  emEspera.forEach(item => { item.status = 'processing'; });
  renderizarFila();

  const BATCH = 5; // Enviar em lotes
  const resultados = [];
  let processados = 0;

  for (let i = 0; i < emEspera.length; i += BATCH) {
    const lote = emEspera.slice(i, i + BATCH);
    const formData = new FormData();
    lote.forEach((item, i) => {
      // Cria um novo Blob com o tipo correto para garantir detecção pelo multer
      const blob = new Blob([item.file], { type: 'application/pdf' });
      // Garante que o nome termina com .pdf para passar no fileFilter
      const nomeSafe = item.file.name.endsWith('.pdf') ? item.file.name : item.file.name + '.pdf';
      formData.append('pdfs', blob, nomeSafe);
    });

    try {
      const resp = await fetch('/api/processar', { method: 'POST', body: formData });
      if (!resp.ok) throw new Error(`Erro HTTP: ${resp.status} — verifique se o servidor está rodando.`);
      const data = await resp.json();

      data.resultados.forEach((res, idx) => {
        lote[idx].status = res.status === 'sucesso' ? 'done' : 'error';
        resultados.push(res);
        processados++;
        progressBar.style.width = `${(processados / emEspera.length) * 100}%`;
      });
    } catch (err) {
      lote.forEach(item => {
        item.status = 'error';
        resultados.push({ arquivo: item.file.name, status: 'erro', erro: err.message, xml: null });
      });
    }

    renderizarFila();
  }

  state.results = [...state.results, ...resultados];

  progressBar.style.width = '100%';
  setTimeout(() => { progressWrapper.remove(); }, 800);

  btnProcessar.disabled = false;
  btnProcessar.innerHTML = `
    <svg viewBox="0 0 20 20" fill="currentColor" width="16"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z"/></svg>
    Processar Todos`;

  renderizarResultados();
  const sucessos = resultados.filter(r => r.status === 'sucesso').length;
  const erros = resultados.filter(r => r.status !== 'sucesso').length;
  showToast(`Concluído! ${sucessos} sucesso(s), ${erros} erro(s).`, sucessos > 0 ? 'success' : 'error');
}

// ─────────────────────────────────────────────
// RENDERIZAR RESULTADOS
// ─────────────────────────────────────────────
function renderizarResultados() {
  if (state.results.length === 0) return;

  resultsSection.style.display = 'block';

  const total   = state.results.length;
  const sucesso = state.results.filter(r => r.status === 'sucesso').length;
  const erros   = total - sucesso;
  const xmlEmb  = state.results.filter(r => r.modo === 'xml_embutido').length;

  resultsSummary.textContent = `${total} arquivo(s) processado(s)`;

  statsBar.innerHTML = `
    <div class="stat-card">
      <div class="stat-label">Total Processados</div>
      <div class="stat-value stat-primary">${total}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Com Sucesso</div>
      <div class="stat-value stat-success">${sucesso}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Com Erro</div>
      <div class="stat-value stat-error">${erros}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">XML Embutido</div>
      <div class="stat-value stat-primary">${xmlEmb}</div>
    </div>
  `;

  // Botão ZIP (se tiver ao menos 2 com XML)
  const comXml = state.results.filter(r => r.xml);
  btnDownloadZip.style.display = comXml.length >= 1 ? 'inline-flex' : 'none';

  resultsBody.innerHTML = '';
  state.results.forEach((res, idx) => {
    const tr = document.createElement('tr');
    const dados = res.dados || {};
    const chave = dados.chaveAcesso || (res.xml ? extrairChaveDoXml(res.xml) : '');
    const numero = dados.numero || '';
    const valor  = dados.valorTotal || '';
    const modo   = res.modo === 'xml_embutido' ? 'xml_embutido' : res.status === 'sucesso' ? 'parseado' : 'erro';
    const modoLabel = res.modo === 'xml_embutido' ? '📎 XML Embutido' : res.status === 'sucesso' ? '🔍 Texto Parseado' : '❌ Erro';

    tr.innerHTML = `
      <td class="td-filename" title="${escHtml(res.arquivo)}">${escHtml(res.arquivo)}</td>
      <td><span class="file-status ${res.status === 'sucesso' ? 'status-done' : 'status-error'}">${res.status === 'sucesso' ? '✓ Sucesso' : '✗ Erro'}</span></td>
      <td><span class="modo-badge modo-${modo}">${modoLabel}</span></td>
      <td class="td-chave" title="${escHtml(chave)}">${chave ? formatarChave(chave) : (res.erro || '—')}</td>
      <td>${numero || '—'}</td>
      <td class="td-valor">${valor ? 'R$ ' + valor : '—'}</td>
      <td class="td-actions">
        ${res.xml ? `<button class="btn btn-outline btn-sm" id="ver-xml-${idx}" data-idx="${idx}">👁 Ver XML</button>` : ''}
        ${res.xml ? `<button class="btn btn-primary btn-sm" id="dl-xml-${idx}" data-idx="${idx}">⬇ Download</button>` : ''}
      </td>
    `;
    resultsBody.appendChild(tr);
  });

  // Listeners dos botões
  document.querySelectorAll('[id^="ver-xml-"]').forEach(btn => {
    btn.addEventListener('click', () => abrirModal(parseInt(btn.dataset.idx)));
  });
  document.querySelectorAll('[id^="dl-xml-"]').forEach(btn => {
    btn.addEventListener('click', () => downloadXml(parseInt(btn.dataset.idx)));
  });

  resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ─────────────────────────────────────────────
// MODAL XML
// ─────────────────────────────────────────────
function abrirModal(idx) {
  const res = state.results[idx];
  state.currentXml = res.xml;
  state.currentXmlName = res.arquivo.replace(/\.pdf$/i, '.xml');
  modalTitle.textContent = `XML — ${res.arquivo}`;
  xmlContent.textContent = res.xml;
  aplicarSyntaxHighlight();
  xmlModal.style.display = 'flex';
  document.body.style.overflow = 'hidden';
}

function fecharModal() {
  xmlModal.style.display = 'none';
  document.body.style.overflow = '';
}

btnCloseModal.addEventListener('click', fecharModal);
xmlModal.addEventListener('click', e => { if (e.target === xmlModal) fecharModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') fecharModal(); });

btnCopyXml.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(state.currentXml);
    showToast('XML copiado para a área de transferência!', 'success');
  } catch { showToast('Não foi possível copiar. Selecione manualmente.', 'error'); }
});

btnDownloadXml.addEventListener('click', () => {
  if (state.currentXml) baixarArquivo(state.currentXml, state.currentXmlName, 'application/xml');
});

// ─────────────────────────────────────────────
// DOWNLOAD ZIP
// ─────────────────────────────────────────────
btnDownloadZip.addEventListener('click', async () => {
  const comXml = state.results.filter(r => r.xml).map(r => ({
    nome: r.arquivo,
    xml: r.xml
  }));

  if (comXml.length === 0) { showToast('Nenhum XML disponível para download.', 'info'); return; }

  btnDownloadZip.disabled = true;
  btnDownloadZip.innerHTML = `<span class="spinner"></span> Gerando ZIP...`;

  try {
    const resp = await fetch('/api/download-zip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ arquivos: comXml })
    });

    if (!resp.ok) throw new Error('Erro ao gerar ZIP.');

    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'xmls_nfe.zip';
    a.click(); URL.revokeObjectURL(url);
    showToast(`ZIP com ${comXml.length} XML(s) baixado com sucesso!`, 'success');
  } catch (err) {
    showToast('Erro ao gerar ZIP: ' + err.message, 'error');
  }

  btnDownloadZip.disabled = false;
  btnDownloadZip.innerHTML = `
    <svg viewBox="0 0 20 20" fill="currentColor" width="16"><path fill-rule="evenodd" d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm3.293-7.707a1 1 0 011.414 0L9 10.586V3a1 1 0 112 0v7.586l1.293-1.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z"/></svg>
    Baixar Todos (ZIP)`;
});

// ─────────────────────────────────────────────
// DOWNLOAD XML INDIVIDUAL
// ─────────────────────────────────────────────
function downloadXml(idx) {
  const res = state.results[idx];
  const nome = res.arquivo.replace(/\.pdf$/i, '.xml');
  baixarArquivo(res.xml, nome, 'application/xml');
  showToast(`XML "${nome}" baixado!`, 'success');
}

function baixarArquivo(conteudo, nome, tipo) {
  const blob = new Blob([conteudo], { type: tipo });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = nome;
  a.click(); URL.revokeObjectURL(url);
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
function statusClass(s) {
  return { waiting: 'status-waiting', processing: 'status-processing', done: 'status-done', error: 'status-error' }[s] || '';
}
function statusLabel(s) {
  return { waiting: '⏳ Aguardando', processing: '⚡ Processando...', done: '✓ Concluído', error: '✗ Erro' }[s] || s;
}
function formatarTamanho(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024*1024) return (bytes/1024).toFixed(1) + ' KB';
  return (bytes/(1024*1024)).toFixed(1) + ' MB';
}
function formatarChave(chave) {
  return chave ? chave.replace(/(\d{4})/g, '$1 ').trim() : '';
}
function extrairChaveDoXml(xml) {
  const m = xml.match(/<chNFe>(\d{44})<\/chNFe>/i) || xml.match(/\b(\d{44})\b/);
  return m ? m[1] : '';
}
function escHtml(str) {
  return (str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function gerarId() {
  return Math.random().toString(36).substr(2, 9);
}

function aplicarSyntaxHighlight() {
  // Highlight básico de XML
  let html = escHtml(state.currentXml);
  html = html.replace(/(&lt;\/?)([a-zA-Z][a-zA-Z0-9_:\-]*)/g, '$1<span style="color:#818cf8">$2</span>');
  html = html.replace(/([a-zA-Z][a-zA-Z0-9_:\-]*)=/g, '<span style="color:#f59e0b">$1</span>=');
  html = html.replace(/&quot;([^&]*)&quot;/g, '&quot;<span style="color:#34d399">$1</span>&quot;');
  xmlContent.innerHTML = html;
}

// ─────────────────────────────────────────────
// TOAST
// ─────────────────────────────────────────────
function showToast(msg, tipo = 'info') {
  const icons = { success: '✅', error: '❌', info: 'ℹ️' };
  const toast = document.createElement('div');
  toast.className = `toast toast-${tipo}`;
  toast.innerHTML = `<span>${icons[tipo]}</span><span>${msg}</span>`;
  toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.style.transition = 'all 0.3s ease';
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(40px)';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}
