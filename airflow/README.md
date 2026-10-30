# Integração Airflow do e-Commerce

## DAG de produtos e preços

Copie `dags/dag_ecommerce_produtos.py` para a pasta de DAGs do Airflow.

Crie as Connections:

- `oracle_filial`: Oracle do WinThor já utilizado pelas DAGs da filial.
- `postgres_ecommerce`: conexão PostgreSQL usando a URL **pública** do banco Railway. O endereço `*.railway.internal` só funciona dentro do projeto Railway.

A DAG `ecommerce_produtos_precos` executa a cada 30 minutos e:

1. lê somente produtos ativos da `PCPRODUT`;
2. lê Varejo na região 1 e Redes na região 12 da `PCTABPR`;
3. insere produtos novos;
4. atualiza somente colunas cujo valor mudou (`IS DISTINCT FROM`);
5. inativa no e-commerce produtos que deixaram de estar ativos no WinThor;
6. preserva as fotos já cadastradas no e-commerce;
7. registra os totais em `product_sync_runs`.

Execute a DAG manualmente uma vez e confira os totais do log antes de habilitar o agendamento.
