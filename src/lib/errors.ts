export class AppError extends Error {
  public readonly code: string;
  public readonly statusCode: number;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class NotFoundError extends AppError {
  constructor(code: string = 'not_found', message: string = 'Resource not found') {
    super(404, code, message);
    this.name = 'NotFoundError';
  }
}

export class ForbiddenError extends AppError {
  constructor(code: string = 'forbidden', message: string = 'Access denied') {
    super(403, code, message);
    this.name = 'ForbiddenError';
  }
}

export class ConflictError extends AppError {
  constructor(code: string = 'conflict', message: string = 'Conflict') {
    super(409, code, message);
    this.name = 'ConflictError';
  }
}

export class BadRequestError extends AppError {
  constructor(code: string = 'bad_request', message: string = 'Bad request') {
    super(400, code, message);
    this.name = 'BadRequestError';
  }
}
