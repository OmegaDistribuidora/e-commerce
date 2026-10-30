# E-commerce Ômega Distribuidora

Aplicação B2B responsiva com catálogo real, identificação de clientes, carrinho e solicitação de pedidos.

## Rodar localmente

```bash
npm install
npm run dev
```

Acesse `http://localhost:5173`. Quando `DATABASE_URL` não está definida, a API inicia um PostgreSQL temporário em memória e carrega o recorte real disponível em `server/seed-data.json`.

Para testar o login local com o cliente real Omega Matriz (`filial.dcliente`, CNPJ `41.600.131/0001-97`), use:

- E-mail: `ecommerce@omegadistribuidora.com.br`
- Senha: `Omega@2026`

Visitantes podem navegar pelo catálogo, mas os preços são enviados pela API somente após uma sessão autenticada. O pedido mínimo é de R$ 200,00 e também é validado no servidor.

## PostgreSQL local persistente

Com o Docker Desktop iniciado:

```bash
docker compose up -d
```

Copie `.env.example` para `.env` ou defina a variável antes de iniciar:

```powershell
$env:DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/omega_ecommerce'
npm run dev
```

As tabelas e o seed inicial são criados automaticamente.

## Atualizar o catálogo de referência

O script abaixo lê produtos, estoque e vendas no DW e consulta o preço vigente diretamente na `PCTABPR` do WinThor. O Varejo usa `PVENDA` da região 1 (Capital e Área Metropolitana) e Redes usa `PVENDA` da região 12, com fallback para a região 1. Nenhuma credencial é gravada no repositório.

```bash
npm run seed:refresh
```

As imagens são associadas pelo código do produto em `public/assets/products`.

## Railway

1. Crie um serviço PostgreSQL no projeto do Railway.
2. No serviço da aplicação, crie `DATABASE_URL` como referência a `${{Postgres.DATABASE_URL}}` (ajuste `Postgres` se o serviço tiver outro nome). Nunca use `localhost` nessa variável no Railway.
3. Não configure `VITE_PORT`; o Railway injeta `PORT` automaticamente e o servidor já utiliza essa porta.
4. Configure `SOURCE_DATABASE_URL` somente quando houver um banco-fonte com `filial.dcliente`. Essa variável não deve apontar para o PostgreSQL vazio da aplicação.
5. Publique o repositório; `railway.json` executará `npm run build` e `npm run start`.

O servidor Express aplica o schema, carrega o seed somente se a tabela de produtos estiver vazia e serve o frontend compilado. A autenticação usa senha derivada com `scrypt` e sessão em cookie HTTP-only. Na consulta de CPF/CNPJ para primeiro acesso, a base local é verificada primeiro; documentos ainda não sincronizados podem ser consultados no DW e copiados para a base da aplicação sem expor credenciais ao navegador.

## Estrutura principal

- `src/`: interface React/TypeScript
- `server/index.js`: API HTTP
- `server/schema.sql`: schema PostgreSQL
- `server/seed-data.json`: catálogo real para inicialização
- `scripts/export-reference-data.py`: exportação segura do DW
- `public/assets/products/`: fotos vinculadas ao código do produto

O ranking “Mais vendidos” é calculado pela tabela `sales`, usando somente os últimos sete dias. A próxima integração operacional deve executar a sincronização de produtos, preços, clientes e vendas em uma rotina agendada.
