export class ApiError extends Error {
  constructor(status, code, message, param = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.param = param;
  }
}

export function fail(status, code, message, param) {
  throw new ApiError(status, code, message, param);
}

export function asApiError(error) {
  if (error instanceof ApiError) return error;
  return new ApiError(502, 'upstream_error', 'The ACP agent failed. Run npm run doctor to check the local runtime.');
}

export function errorBody(error, format = 'chat') {
  const e = asApiError(error);
  if (format === 'messages') {
    const type = e.status === 401 ? 'authentication_error' : e.status === 429 ? 'rate_limit_error'
      : e.status >= 500 ? 'api_error' : 'invalid_request_error';
    return { type: 'error', error: { type, message: e.message }, code: e.code };
  }
  return { error: { message: e.message, type: e.status >= 500 ? 'api_error' : 'invalid_request_error', code: e.code, param: e.param } };
}
