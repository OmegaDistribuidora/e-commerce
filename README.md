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

Visitantes podem navegar pelo catálogo. Os preços são enviados pela API somente para clientes autenticados, aprovados e com região e planos de pagamento já sincronizados do WinThor. O pedido mínimo é de R$ 200,00 e também é validado no servidor.

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

## Atualizar o catálogo de referência local

O comando abaixo atualiza apenas os dados de referência usados no desenvolvimento local. Ele não é a fonte operacional do ambiente de produção:

```bash
npm run seed:refresh
```

Em produção, produtos, hierarquia comercial, preços por região, planos de pagamento, limite de crédito e compromissos financeiros são sincronizados do WinThor pela DAG descrita em `airflow/README.md`. Nenhuma credencial deve ser gravada no repositório.

## Railway

1. Crie um serviço PostgreSQL no projeto do Railway.
2. No serviço da aplicação, crie `DATABASE_URL` como referência a `${{Postgres.DATABASE_URL}}` (ajuste `Postgres` se o serviço tiver outro nome). Nunca use `localhost` nessa variável no Railway.
3. Não configure `VITE_PORT`; o Railway injeta `PORT` automaticamente e o servidor já utiliza essa porta.
4. Configure `SOURCE_DATABASE_URL` somente quando houver um banco-fonte com `filial.dcliente`. Essa variável não deve apontar para o PostgreSQL vazio da aplicação.
5. A infraestrutura do serviço está declarada em `.railway/railway.ts`. O Railpack detecta os scripts do `package.json`, executa `npm run build` e inicia a aplicação com `npm run start`.

O arquivo de infraestrutura mantém as variáveis como **não gerenciadas pelo código**: segredos e configurações continuam no painel do Railway e nunca são copiados para o repositório. Para conferir uma mudança de infraestrutura antes de aplicá-la, use `railway config plan`; para aplicá-la, use `railway config apply`.

O servidor Express aplica o schema, carrega o seed somente se a tabela de produtos estiver vazia e serve o frontend compilado. Clientes usam Supabase Auth, com JWT validado no backend e vínculo pelo campo `supabase_user_id`. Usuários internos continuam usando senha derivada com `scrypt` e sessão em cookie HTTP-only. Senhas e chaves privadas do Supabase não são armazenadas no frontend.

### Autenticação de clientes

O Supabase é usado exclusivamente para autenticação; catálogo, clientes, pedidos e demais dados comerciais continuam no PostgreSQL do Railway. Configure no backend `SUPABASE_URL`, `SUPABASE_JWT_AUDIENCE` e `SUPABASE_SERVICE_ROLE_KEY`. No frontend, exponha somente `VITE_SUPABASE_URL` e `VITE_SUPABASE_PUBLISHABLE_KEY`.

Cadastro, confirmação por OTP e recuperação de senha usam o SMTP configurado no Supabase. A credencial SMTP/Resend e a `SUPABASE_SERVICE_ROLE_KEY` nunca devem usar o prefixo `VITE_` nem ser enviadas ao navegador.

### Conta administrativa

Defina no serviço do e-commerce:

- `ADMIN_EMAIL` (opcional; padrão `admin@omegadistribuidora.com.br`)
- `ADMIN_NAME` (opcional)
- `ADMIN_PASSWORD` (obrigatória para criar o primeiro administrador)
- `ADMIN_PASSWORD_RESET=true` (opcional; redefine a senha da conta `ADMIN_EMAIL` para `ADMIN_PASSWORD` na inicialização e encerra as sessões dela. Remova a variável depois do primeiro acesso)

A conta inicial é criada apenas quando ainda não existe. Depois, o Administrador cria usuários Administradores, Comerciais ou de Marketing em `/gestao`. Somente Administradores criam usuários internos.

### Sincronização WinThor

A DAG versionada em `airflow/dags/dag_ecommerce_produtos.py` executa a cada 30 minutos. Ela sincroniza somente produtos ativos e habilitados para a força de vendas, hierarquia Departamento → Seção, preços por região e plano, condições comerciais e compromissos de crédito. Os dados são enviados à API HTTPS protegida por `PRODUCT_SYNC_TOKEN`; o PostgreSQL permanece privado no Railway. Consulte `airflow/README.md` para implantação, Connections e validação operacional.

### Organização do catálogo

O catálogo utiliza exclusivamente a hierarquia `Departamento → Seção → Produtos` sincronizada do WinThor. Não existe manutenção manual de categorias na área de gestão.

Os perfis internos são:

- `ADMIN`: acesso completo, clientes, pedidos, marketing e criação de usuários;
- `COMERCIAL`: pedidos, aprovação/cadastro de clientes e configurações da própria conta;
- `MARKETING`: banners, fotos de produtos e configurações da própria conta.

### Preços, planos e crédito

- A região de preço vem de `PCCLIENT.NUMREGIAOCLI`; quando não informada, usa `PCPRACA.NUMREGIAO`.
- Os planos liberados vêm de `PCPLPAGCLI`; se não houver registros para o cliente, usa-se `PCCLIENT.CODPLPAG`.
- Entram somente planos ativos em `PCPLPAG` e que não sejam de bonificação/troca (`TIPOPRAZO <> 'B'`).
- `PCPLPAG.NUMPR` seleciona a coluna `PCTABPR.PTABELA1` a `PTABELA7`.
- Catálogo e página do produto mostram o menor preço positivo entre os planos liberados. O checkout recalcula o pedido no backend para o plano escolhido.
- Cliente ainda não aprovado ou sem condições comerciais sincronizadas não recebe preço e não pode finalizar pedidos.
- Crédito disponível = `LIMCRED` − títulos em aberto − pedidos não faturados no WinThor − pedidos do e-commerce ainda não considerados pela última leitura do WinThor.
- O checkout impede pedidos acima do crédito disponível.

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
- `server/seed-data.json`: recorte de referência para inicialização local
- `scripts/export-reference-data.py`: exportação segura do DW
- `.railway/railway.ts`: infraestrutura do serviço no Railway

O ranking “Mais vendidos” é calculado pela tabela `sales`, usando somente os últimos sete dias. A sincronização operacional de produtos, preços e condições comerciais é executada pela DAG do Airflow a cada 30 minutos.
