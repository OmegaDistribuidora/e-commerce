import { CircleX, ClipboardCheck, Hourglass, PackageCheck, Truck, type LucideIcon } from "lucide-react";
import { formatDeliveryDate } from "./orderStatus";
import type { Order } from "./types";

type Step = {
  key: "analysis" | "released" | "sent" | "delivered";
  label: string;
  icon: LucideIcon;
  date?: string | null;
};

const stepRank: Record<string, number> = { analysis: 0, released: 1, sent: 2, delivered: 3 };

// Dia e hora no fuso de Brasília, compacto para a barra: 24/11 às 13:38.
function stepDateTime(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)?.value || "";
  return `${part("day")}/${part("month")} às ${part("hour")}:${part("minute")}`;
}

// Etapa alcançada por um pedido cancelado: a última com data registrada.
function cancelledRank(order: Order) {
  if (order.invoicedAt) return 2;
  if (order.releasedAt || order.winthorOrderNumber) return 1;
  return 0;
}

export default function OrderProgress({ order }: { order: Order }) {
  const cancelled = order.status === "cancelled";
  const reached = cancelled ? cancelledRank(order) : (stepRank[order.status] ?? 0);
  const delivered = !cancelled && order.status === "delivered";
  const forecast = formatDeliveryDate(order.deliveryDate);

  const steps: Step[] = [
    { key: "analysis", label: "Em análise", icon: Hourglass, date: stepDateTime(order.createdAt) },
    { key: "released", label: "Liberado", icon: ClipboardCheck, date: stepDateTime(order.releasedAt) },
    { key: "sent", label: "Enviado", icon: Truck, date: stepDateTime(order.invoicedAt) },
    {
      key: "delivered",
      label: "Entregue",
      icon: PackageCheck,
      // A data exibida é sempre a previsão (DTENTREGA + 2 dias úteis).
      date: forecast ? (delivered ? forecast : `Previsão ${forecast}`) : "",
    },
  ];

  return (
    <ol
      className={`order-progress${cancelled ? " is-cancelled" : ""}`}
      aria-label="Andamento do pedido"
    >
      {steps.map((step, index) => {
        const Icon = step.icon;
        const done = index <= reached && !(cancelled && index > reached);
        const current = !cancelled && index === reached && !delivered;
        const showCancel = cancelled && index === reached + 1;
        const skipped = cancelled && index > reached;
        if (showCancel) {
          return (
            <li key="cancelled" className="order-progress-step cancelled">
              <span className="order-progress-node">
                <CircleX />
              </span>
              <strong>Cancelado</strong>
              <small>{stepDateTime(order.cancelledAt)}</small>
            </li>
          );
        }
        if (skipped) {
          return (
            <li key={step.key} className="order-progress-step skipped" aria-hidden="true">
              <span className="order-progress-node">
                <Icon />
              </span>
              <strong>{step.label}</strong>
              <small />
            </li>
          );
        }
        return (
          <li
            key={step.key}
            className={`order-progress-step${done ? " done" : ""}${current ? " current" : ""}`}
            aria-current={current ? "step" : undefined}
          >
            <span className="order-progress-node">
              <Icon />
            </span>
            <strong>{step.label}</strong>
            <small>{done || step.key === "delivered" ? step.date : ""}</small>
          </li>
        );
      })}
      {cancelled && reached === steps.length - 1 && (
        <li className="order-progress-step cancelled">
          <span className="order-progress-node">
            <CircleX />
          </span>
          <strong>Cancelado</strong>
          <small>{stepDateTime(order.cancelledAt)}</small>
        </li>
      )}
    </ol>
  );
}
