# 📄 Extrator XML NF-e

Aplicação web para extração de XML de Notas Fiscais Eletrônicas (NF-e) a partir de arquivos PDF.

Desenvolvido para **Cleber Serviços Contábeis**.

## ✨ Funcionalidades

- 🎯 **Drag & Drop** — arraste PDFs direto para a tela
- 📁 **Processamento em lote** — processe uma pasta inteira de PDFs
- 📎 **XML embutido** — extrai o XML original de PDFs de NF-e
- 🔍 **Parsing de DANFE** — lê o texto do PDF e gera XML estruturado
- 👁 **Visualizador XML** — veja o XML com syntax highlighting
- ⬇ **Download individual** — baixe cada XML separado
- 🗜 **Download ZIP** — baixe todos os XMLs de uma vez

## 🚀 Hospedagem no Vercel

Clique no botão abaixo para fazer deploy em um clique:

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/SEU_USUARIO/extrator-xml-nfe)

## 💻 Rodar Localmente

```bash
# Instalar dependências
npm install

# Iniciar servidor
npm start
```

Acesse: [http://localhost:3000](http://localhost:3000)

## 🏗 Estrutura do Projeto

```
extrator-xml-nfe/
├── api/
│   └── index.js        # Handler serverless (Vercel) + backend local
├── public/
│   ├── index.html      # Interface web
│   ├── style.css       # Estilos dark mode
│   └── app.js          # Lógica do frontend
├── server.js           # Servidor local (redireciona para api/)
├── vercel.json         # Configuração do Vercel
└── package.json
```

## ⚙️ Limites no Vercel (Plano Gratuito)

| Recurso | Limite |
|---|---|
| Tamanho máximo por arquivo | 10 MB |
| Arquivos por lote | 20 |
| Tempo máximo de execução | 10 segundos |

> Para processar arquivos maiores ou em maior volume, rode localmente com `npm start`.

## 📋 Tecnologias

- **Backend**: Node.js + Express
- **Upload**: Multer (memória)
- **PDF**: pdf-parse, pdf-lib
- **XML**: xml2js
- **Frontend**: HTML + CSS + JavaScript puro
