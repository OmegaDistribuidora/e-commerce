# Integração Airflow do e-Commerce

## DAG de produtos e preços

Copie `dags/dag_ecommerce_produtos.py` para a pasta de DAGs do Airflow.

Crie as Connections:

- `lancamentos_oracle_filial`: Oracle do WinThor já utilizado pelas DAGs atuais.
- `ecommerce_api`: use a URL pública do e-commerce no campo `Host` e o mesmo valor de `PRODUCT_SYNC_TOKEN` no campo `Password`.

Não é necessário habilitar acesso público ao PostgreSQL. A DAG envia os dados por HTTPS para uma rota autenticada da aplicação, e somente o servidor do Railway acessa o banco pela rede privada.

Neste ambiente, a task usa o Python do Windows e o Oracle Client já instalado para manter compatibilidade com o verificador de senha legado do WinThor. As credenciais das Connections são encaminhadas somente no ambiente do processo e não são gravadas em arquivos ou logs.

A DAG `ecommerce_produtos_precos` executa a cada 30 minutos e:

1. lê somente produtos ativos da `PCPRODUT`, excluindo os itens fora de linha (`OBS2 = 'FL'`) e mantendo apenas `ENVIARFORCAVENDAS = 'S'`;
2. lê os preços `PTABELA1` a `PTABELA7` da `PCTABPR` para as regiões em uso (1, 12 e a região de cada cliente aprovado);
3. insere produtos novos;
4. a API atualiza somente colunas cujo valor mudou (`IS DISTINCT FROM`);
5. inativa no e-commerce produtos que deixaram de estar ativos no WinThor;
6. preserva as fotos já cadastradas no e-commerce;
7. registra os totais em `product_sync_runs`.
8. atualiza código do fabricante, NCM, EAN, múltiplo e embalagem master;
9. atualiza os planos de pagamento liberados, o `LIMCRED`, os títulos em aberto (`PCPREST` sem `DTPAG`, sem cancelamento/estorno e sem cobranças que não são dívida) e os pedidos não faturados (`PCPEDC` nas posições L, M, B e P, exceto bonificação e transferência) dos clientes aprovados.

O crédito disponível no checkout é `LIMCRED − títulos em aberto − pedidos não faturados no WinThor − pedidos do e-commerce que ainda não estavam no WinThor na última leitura`. Quando o cliente paga um título, o valor volta a ficar disponível na sincronização seguinte.

No Railway, crie `PRODUCT_SYNC_TOKEN` no serviço `e-commerce` com um valor longo e aleatório. Use exatamente o mesmo valor como senha da Connection `ecommerce_api` no Airflow. Não grave o token no arquivo da DAG.

Execute a DAG manualmente uma vez e confira os totais do log antes de habilitar o agendamento.

### Preço por cliente

Cada cliente aprovado compra pelo preço da própria região e do plano de pagamento escolhido:

- região = `PCCLIENT.NUMREGIAOCLI` ou, se vazia, `PCPRACA.NUMREGIAO` da praça do cliente;
- planos liberados = `PCPLPAGCLI` (CODCLI × CODPLPAG); sem linhas nela, vale o `PCCLIENT.CODPLPAG`. Só entram planos ativos (`PCPLPAG.STATUS = 'A'`) que não são bonificação/troca (`TIPOPRAZO <> 'B'`), com o nome de `PCPLPAG.DESCRICAO`;
- coluna de preço = `PCPLPAG.NUMPR` do plano (1 a 7 → `PTABELA1` a `PTABELA7`);
- o e-commerce guarda uma linha por região e produto (`region_prices`), e não por cliente, e só grava preços que mudaram;
- cadastros ainda sem condições sincronizadas veem `PTABELA1` da região do canal (Varejo = 1, Redes = 12);
- produtos com preço zerado na região do cliente aparecem como indisponíveis para ele.
