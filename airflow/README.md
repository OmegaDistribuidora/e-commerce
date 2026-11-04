# Integração Airflow do e-Commerce

## DAG de produtos e preços

Copie `dags/dag_ecommerce_produtos.py` para a pasta de DAGs do Airflow.

Crie as Connections:

- `lancamentos_oracle_filial`: Oracle do WinThor já utilizado pelas DAGs atuais.
- `ecommerce_api`: use a URL pública do e-commerce no campo `Host` e o mesmo valor de `PRODUCT_SYNC_TOKEN` no campo `Password`.

Não é necessário habilitar acesso público ao PostgreSQL. A DAG envia os dados por HTTPS para uma rota autenticada da aplicação, e somente o servidor do Railway acessa o banco pela rede privada.

Neste ambiente, a task usa o Python do Windows e o Oracle Client já instalado para manter compatibilidade com o verificador de senha legado do WinThor. As credenciais das Connections são encaminhadas somente no ambiente do processo e não são gravadas em arquivos ou logs.

A DAG `ecommerce_produtos_precos` executa a cada 30 minutos e:

1. lê somente produtos ativos da `PCPRODUT`;
2. lê Varejo na região 1 e Redes na região 12 da `PCTABPR`;
3. insere produtos novos;
4. a API atualiza somente colunas cujo valor mudou (`IS DISTINCT FROM`);
5. inativa no e-commerce produtos que deixaram de estar ativos no WinThor;
6. preserva as fotos já cadastradas no e-commerce;
7. registra os totais em `product_sync_runs`.
8. atualiza código do fabricante, NCM, EAN, múltiplo e embalagem master;
9. atualiza os planos de pagamento liberados e o `LIMCRED` dos clientes aprovados.

No Railway, crie `PRODUCT_SYNC_TOKEN` no serviço `e-commerce` com um valor longo e aleatório. Use exatamente o mesmo valor como senha da Connection `ecommerce_api` no Airflow. Não grave o token no arquivo da DAG.

Execute a DAG manualmente uma vez e confira os totais do log antes de habilitar o agendamento.
