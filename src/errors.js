/** 类型化业务错误，HTTP 层据此映射状态码。 */
export class DomainError extends Error {
  constructor(message, { code = "DOMAIN_ERROR", status = 400, details } = {}) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

export class ValidationError extends DomainError {
  constructor(message, details) {
    super(message, { code: "VALIDATION", status: 400, details });
    this.name = "ValidationError";
  }
}

export class ConflictError extends DomainError {
  constructor(message, code = "CONFLICT", details) {
    super(message, { code, status: 409, details });
    this.name = "ConflictError";
  }
}

export class AuthzError extends DomainError {
  constructor(message, code = "FORBIDDEN", details) {
    super(message, { code, status: 403, details });
    this.name = "AuthzError";
  }
}

export class NotFoundError extends DomainError {
  constructor(message, details) {
    super(message, { code: "NOT_FOUND", status: 404, details });
    this.name = "NotFoundError";
  }
}

export class StateError extends DomainError {
  constructor(message, code = "INVALID_STATE", details) {
    super(message, { code, status: 409, details });
    this.name = "StateError";
  }
}
