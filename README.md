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

### Conta administrativa

Defina no serviço do e-commerce:

- `ADMIN_EMAIL` (opcional; padrão `admin@omegadistribuidora.com.br`)
- `ADMIN_NAME` (opcional)
- `ADMIN_PASSWORD` (obrigatória para criar o primeiro administrador)

A conta inicial é criada apenas quando ainda não existe. Depois, o Administrador cria outros usuários Administradores ou Comerciais em `/gestao`. Administradores e Comerciais consultam pedidos e gerenciam banners; somente Administradores criam usuários internos.

### Sincronização WinThor

A DAG versionada em `airflow/dags/dag_ecommerce_produtos.py` atualiza produtos ativos e preços a cada 30 minutos. Ela envia o catálogo à API HTTPS protegida por `PRODUCT_SYNC_TOKEN`; o PostgreSQL permanece privado no Railway. Consulte `airflow/README.md` para configurar as Connections `lancamentos_oracle_filial` e `ecommerce_api`.

### Organização do catálogo

O catálogo utiliza exclusivamente a hierarquia `Departamento → Seção → Produtos` sincronizada do WinThor. Não existe manutenção manual de categorias na área de gestão.

Os perfis internos são:

- `ADMIN`: acesso completo e criação de usuários;
- `COMERCIAL`: pedidos, clientes, banners e fotos de produtos;
- `MARKETING`: somente banners, fotos de produtos e configurações da própria conta.

### Status dos pedidos no WinThor

Administradores e Comerciais liberam um pedido informando obrigatoriamente o `NUMPED`. O backend consulta a API Omega somente por HTTPS com `X-API-Key`; a credencial nunca é enviada ao navegador. Configure no Railway:

- `OMEGA_API_URL=https://apiomega.williamfmarinho.com.br`
- `OMEGA_API_KEY` com a chave armazenada no `.env` da API Omega
- `ORDER_STATUS_CACHE_MINUTES=15`

O cliente vê apenas **Em análise**, **Liberado** ou **Enviado**. O painel interno também mostra a posição real retornada pelo WinThor. A última resposta fica persistida no PostgreSQL por 15 minutos e continua disponível durante indisponibilidades temporárias da API ou do WinThor.

Enquanto o pedido está **Em análise** e ainda não tem `NUMPED`, ele pode ser cancelado pelo próprio cliente (Minha conta → Meus pedidos) ou por Administradores e Comerciais no painel de gestão. Pedido cancelado deixa de consumir o crédito do cliente e não pode mais ser vinculado ao WinThor. Depois de vinculado a um `NUMPED`, o cancelamento deve ser feito no WinThor.

## Estrutura principal

- `src/`: interface React/TypeScript
- `server/index.js`: API HTTP
- `server/schema.sql`: schema PostgreSQL
- `server/seed-data.json`: catálogo real para inicialização
- `scripts/export-reference-data.py`: exportação segura do DW
- `public/assets/products/`: fotos vinculadas ao código do produto

O ranking “Mais vendidos” é calculado pela tabela `sales`, usando somente os últimos sete dias. A próxima integração operacional deve executar a sincronização de produtos, preços, clientes e vendas em uma rotina agendada.
