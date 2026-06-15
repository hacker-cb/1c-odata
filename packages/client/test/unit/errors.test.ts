import {
  BusinessError,
  ConcurrencyError,
  HTTPError,
  type HTTPErrorOptions,
  InvalidArgumentError,
  MetadataError,
  NetworkError,
  ODataError,
  ParseError,
  PermissionError,
  TimeoutError,
  ValidationError,
} from '@1c-odata/client'
import { describe, expect, it } from 'vitest'

const httpOpts: HTTPErrorOptions = {
  status: 500,
  statusText: 'Internal Server Error',
  code: '-1',
  errorFormat: 'json',
  odata: { code: '-1', message: 'Boom' },
}

describe('error hierarchy: instanceof', () => {
  it('HTTPError extends ODataError', () => {
    expect(new HTTPError('x', httpOpts)).toBeInstanceOf(ODataError)
  })

  it('BusinessError extends HTTPError and ODataError', () => {
    const e = new BusinessError('x', httpOpts)
    expect(e).toBeInstanceOf(HTTPError)
    expect(e).toBeInstanceOf(ODataError)
  })

  it('ConcurrencyError extends HTTPError', () => {
    expect(new ConcurrencyError('x', { ...httpOpts, status: 412, statusText: 'Precondition Failed' })).toBeInstanceOf(
      HTTPError,
    )
  })

  it('PermissionError extends HTTPError', () => {
    expect(new PermissionError('x', { ...httpOpts, status: 401, statusText: 'Unauthorized' })).toBeInstanceOf(HTTPError)
  })

  it('NetworkError extends ODataError', () => {
    expect(new NetworkError('ECONNRESET')).toBeInstanceOf(ODataError)
  })

  it('TimeoutError extends ODataError', () => {
    expect(new TimeoutError('Request timed out after 30000ms', { timeoutMs: 30_000 })).toBeInstanceOf(ODataError)
  })

  it('ParseError extends ODataError', () => {
    expect(new ParseError('invalid JSON')).toBeInstanceOf(ODataError)
  })

  it('ValidationError extends ODataError', () => {
    expect(new ValidationError('MaxLength exceeded', { issues: [] })).toBeInstanceOf(ODataError)
  })

  it('InvalidArgumentError extends ODataError', () => {
    expect(new InvalidArgumentError('x')).toBeInstanceOf(ODataError)
  })

  it('MetadataError extends ODataError', () => {
    expect(new MetadataError('bad metadata')).toBeInstanceOf(ODataError)
  })
})

describe('error contract: cause propagation', () => {
  const cases: Array<{ name: string; make: (cause: unknown) => ODataError }> = [
    { name: 'HTTPError', make: (cause) => new HTTPError('msg', { ...httpOpts, cause }) },
    { name: 'BusinessError', make: (cause) => new BusinessError('msg', { ...httpOpts, cause }) },
    { name: 'ConcurrencyError', make: (cause) => new ConcurrencyError('msg', { ...httpOpts, cause }) },
    { name: 'PermissionError', make: (cause) => new PermissionError('msg', { ...httpOpts, cause }) },
    { name: 'NetworkError', make: (cause) => new NetworkError('msg', { cause }) },
    { name: 'TimeoutError', make: (cause) => new TimeoutError('msg', { timeoutMs: 1000, cause }) },
    { name: 'ParseError', make: (cause) => new ParseError('msg', { cause }) },
    { name: 'ValidationError', make: (cause) => new ValidationError('msg', { issues: [], cause }) },
    { name: 'InvalidArgumentError', make: (cause) => new InvalidArgumentError('msg', { cause }) },
    { name: 'MetadataError', make: (cause) => new MetadataError('msg', { cause }) },
  ]

  for (const { name, make } of cases) {
    it(`${name} forwards cause via ES2022 Error.cause`, () => {
      const orig = new Error('original')
      const err = make(orig)
      expect(err.cause).toBe(orig)
    })
  }
})

describe('error contract: name property', () => {
  const cases: [string, ODataError][] = [
    ['HTTPError', new HTTPError('x', httpOpts)],
    ['BusinessError', new BusinessError('x', httpOpts)],
    ['ConcurrencyError', new ConcurrencyError('x', httpOpts)],
    ['PermissionError', new PermissionError('x', httpOpts)],
    ['NetworkError', new NetworkError('x')],
    ['TimeoutError', new TimeoutError('x', { timeoutMs: 1 })],
    ['ParseError', new ParseError('x')],
    ['ValidationError', new ValidationError('x', { issues: [] })],
    ['InvalidArgumentError', new InvalidArgumentError('x')],
    ['MetadataError', new MetadataError('x')],
  ]

  for (const [expected, err] of cases) {
    it(`${expected} has name="${expected}"`, () => {
      expect(err.name).toBe(expected)
    })
  }
})

describe('HTTPError fields', () => {
  it('exposes status, statusText, code, errorFormat, odata', () => {
    const e = new HTTPError('msg', httpOpts)
    expect(e.status).toBe(500)
    expect(e.statusText).toBe('Internal Server Error')
    expect(e.code).toBe('-1')
    expect(e.errorFormat).toBe('json')
    expect(e.odata).toEqual({ code: '-1', message: 'Boom' })
  })

  it('BusinessError carries 1C error code "-1"', () => {
    const err = new BusinessError('HTTP 500 Internal Server Error: Не удалось провести', {
      status: 500,
      statusText: 'Internal Server Error',
      code: '-1',
      errorFormat: 'json',
      odata: { code: '-1', message: 'Не удалось провести' },
    })
    expect(err.code).toBe('-1')
    expect(err.status).toBe(500)
    expect(err.message).toContain('Не удалось провести')
  })

  it('JSON-serializable for logging (name/status/code/message)', () => {
    const err = new HTTPError('HTTP 404 Not Found: Экземпляр сущности не найден', {
      status: 404,
      statusText: 'Not Found',
      code: '9',
      errorFormat: 'json',
      odata: { code: '9', message: 'Экземпляр сущности не найден' },
    })
    const obj = JSON.parse(JSON.stringify({ name: err.name, status: err.status, code: err.code, message: err.message }))
    expect(obj).toEqual({
      name: 'HTTPError',
      status: 404,
      code: '9',
      message: 'HTTP 404 Not Found: Экземпляр сущности не найден',
    })
  })

  it('no-envelope shape: errorFormat "none" omits code/odata, carries rawBody', () => {
    const e = new HTTPError('HTTP 404 Not Found: server returned no OData error envelope', {
      status: 404,
      statusText: 'Not Found',
      errorFormat: 'none',
      rawBody: '<html>404</html>',
    })
    expect(e.status).toBe(404)
    expect(e.errorFormat).toBe('none')
    expect(e.code).toBeUndefined()
    expect(e.odata).toBeUndefined()
    expect(e.rawBody).toBe('<html>404</html>')
  })
})

describe('ODataError request context', () => {
  it('carries request on request-originated errors', () => {
    const request = { method: 'GET', url: 'http://x/Catalog_X' }
    expect(new HTTPError('boom', { ...httpOpts, request }).request).toEqual(request)
    expect(new NetworkError('ECONNRESET', { request }).request).toEqual(request)
    expect(new TimeoutError('timed out', { timeoutMs: 1, request }).request).toEqual(request)
  })

  it('is undefined on errors not tied to a request', () => {
    expect(new InvalidArgumentError('x').request).toBeUndefined()
    expect(new ValidationError('x', { issues: [] }).request).toBeUndefined()
    expect(new MetadataError('x').request).toBeUndefined()
  })
})

describe('TimeoutError fields', () => {
  it('exposes timeoutMs', () => {
    expect(new TimeoutError('x', { timeoutMs: 5000 }).timeoutMs).toBe(5000)
  })
})

describe('ValidationError fields', () => {
  it('exposes issues', () => {
    const issues = [{ kind: 'required' as const, field: 'foo' }]
    expect(new ValidationError('x', { issues }).issues).toBe(issues)
  })
})

describe('InvalidArgumentError fields', () => {
  it('exposes argument and received', () => {
    const e = new InvalidArgumentError('Invalid top', { argument: 'top', received: -1 })
    expect(e.argument).toBe('top')
    expect(e.received).toBe(-1)
  })

  it('handles missing options', () => {
    const e = new InvalidArgumentError('msg')
    expect(e.argument).toBeUndefined()
    expect(e.received).toBeUndefined()
  })
})
