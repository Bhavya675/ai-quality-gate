interface Order {
  id: string;
  amount: number;
  customerId: string;
}

const orders: Order[] = [];

export function createOrder(order: Order): Order {
  // Issue 1: No validation for negative or zero amounts.
  // Issue 2: No validation for empty customer ID.

  orders.push(order);

  return order;
}

export function getOrder(orderId: string): Order | undefined {
  // Issue 3: Returns an order without checking whether
  // the caller is authorized to access it.

  return orders.find((order) => order.id === orderId);
}

export function calculateDiscount(amount: number): number {
  // Issue 4: Discount can become negative for invalid amounts.
  return amount * 0.2;
}
