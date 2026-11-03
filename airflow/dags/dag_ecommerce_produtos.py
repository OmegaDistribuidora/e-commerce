"""Agenda a sincronização WinThor -> API HTTPS -> PostgreSQL privado."""

from __future__ import annotations

from datetime import timedelta
import os
import subprocess

import pendulum
from airflow import DAG
from airflow.exceptions import AirflowException
from airflow.providers.standard.operators.python import PythonOperator
from airflow.sdk.bases.hook import BaseHook


ORACLE_CONN_ID = "lancamentos_oracle_filial"
ECOMMERCE_API_CONN_ID = "ecommerce_api"
APP_WIN = os.getenv("ECOMMERCE_APP_WIN", r"C:\Repos\e-commerce")
APP_LINUX = os.getenv("ECOMMERCE_APP_LINUX", "/mnt/c/Repos/e-commerce")
PYTHON_WIN = os.getenv(
    "ECOMMERCE_SYNC_PYTHON",
    "/mnt/c/Users/POWERBI/OneDrive - omegadistribuidora.com.br/Projetos/Projetos/Transf_Dados/venv_transf/Scripts/python.exe",
)
LOCAL_TZ = pendulum.timezone("America/Sao_Paulo")


def _decode(content: bytes) -> str:
    for encoding in ("utf-8", "cp1252", "latin-1"):
        try:
            return content.decode(encoding)
        except UnicodeDecodeError:
            continue
    return content.decode("utf-8", errors="replace")


def _oracle_env() -> dict[str, str]:
    connection = BaseHook.get_connection(ORACLE_CONN_ID)
    service = connection.schema or str((connection.extra_dejson or {}).get("service_name") or "")
    if not connection.host or not connection.login or not connection.password or not service:
        raise AirflowException(f"Connection {ORACLE_CONN_ID} incompleta.")
    return {
        "ORACLE_FILIAL_HOST": connection.host,
        "ORACLE_FILIAL_PORT": str(connection.port or 1521),
        "ORACLE_FILIAL_SERVICE": service,
        "ORACLE_FILIAL_USER": connection.login,
        "ORACLE_FILIAL_PASSWORD": connection.password,
    }


def sync_products() -> None:
    destination = BaseHook.get_connection(ECOMMERCE_API_CONN_ID)
    if not destination.host or not destination.password:
        raise AirflowException(f"Connection {ECOMMERCE_API_CONN_ID} incompleta.")

    env = os.environ.copy()
    env.update(_oracle_env())
    env.update({
        "ECOMMERCE_API_URL": destination.host.rstrip("/"),
        "ECOMMERCE_PRODUCT_SYNC_TOKEN": destination.password,
        "PRODUCT_SYNC_MIN_COUNT": "100",
        "PYTHONUNBUFFERED": "1",
        "TZ": "America/Sao_Paulo",
    })

    forwarded = [item for item in env.get("WSLENV", "").split(":") if item]
    forwarded_names = {item.split("/", 1)[0] for item in forwarded}
    names = [
        key for key in env
        if key.startswith(("ORACLE_FILIAL_", "ECOMMERCE_", "PRODUCT_SYNC_"))
    ] + ["PYTHONUNBUFFERED", "TZ"]
    for name in names:
        if name not in forwarded_names:
            forwarded.append(f"{name}/w")
    env["WSLENV"] = ":".join(forwarded)

    script_win = rf"{APP_WIN}\scripts\sync-ecommerce-winthor.py"
    result = subprocess.run(
        [PYTHON_WIN, script_win],
        cwd=APP_LINUX,
        env=env,
        capture_output=True,
        check=False,
        timeout=18 * 60,
    )
    stdout, stderr = _decode(result.stdout), _decode(result.stderr)
    if stdout.strip():
        print(stdout.strip())
    if stderr.strip():
        print(stderr.strip())
    if result.returncode:
        raise AirflowException(f"Sincronização do e-commerce falhou (exit code {result.returncode}).")


with DAG(
    dag_id="ecommerce_produtos_precos",
    description="Sincroniza produtos ativos e preços PCTABPR com o e-commerce.",
    default_args={
        "owner": "omega",
        "depends_on_past": False,
        "email_on_failure": False,
        "email_on_retry": False,
        "retries": 2,
        "retry_delay": timedelta(minutes=5),
    },
    start_date=pendulum.datetime(2026, 1, 1, 0, 0, tz=LOCAL_TZ),
    schedule="*/30 * * * *",
    catchup=False,
    max_active_runs=1,
    dagrun_timeout=timedelta(minutes=20),
    is_paused_upon_creation=True,
    tags=["omega", "ecommerce", "winthor", "produtos", "precos"],
) as dag:
    PythonOperator(
        task_id="sincronizar_produtos_e_precos",
        python_callable=sync_products,
        execution_timeout=timedelta(minutes=18),
    )
