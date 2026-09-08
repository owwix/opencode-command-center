export class GatewayPolicyError extends Error {
  constructor(message, statusCode = 403) {
    super(message);
    this.statusCode = statusCode;
  }
}
