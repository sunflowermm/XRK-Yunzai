/**
 * 公共 multipart/form-data 解析（Buffer 级分割，避免 binary 字符串损坏二进制）
 * 返回 { files, fields }，供 ai.js、files.js 等复用
 *
 * @param {import('http').IncomingMessage} req
 * @param {{ maxBodyBytes?: number|null, maxFileBytes?: number|null }} [options]
 */
const HEADER_SEP = Buffer.from('\r\n\r\n');

function splitMultipartBody(body, boundary) {
  const delimiter = Buffer.from(`--${boundary}`);
  const parts = [];
  let cursor = 0;

  while (cursor < body.length) {
    const start = body.indexOf(delimiter, cursor);
    if (start === -1) break;

    let partStart = start + delimiter.length;
    if (partStart + 1 < body.length && body[partStart] === 0x2d && body[partStart + 1] === 0x2d) {
      break;
    }

    if (body[partStart] === 0x0d && body[partStart + 1] === 0x0a) partStart += 2;
    else if (body[partStart] === 0x0a) partStart += 1;

    const next = body.indexOf(delimiter, partStart);
    if (next === -1) break;

    let partEnd = next;
    if (partEnd >= 2 && body[partEnd - 2] === 0x0d && body[partEnd - 1] === 0x0a) {
      partEnd -= 2;
    } else if (partEnd >= 1 && body[partEnd - 1] === 0x0a) {
      partEnd -= 1;
    }

    if (partEnd > partStart) {
      parts.push(body.subarray(partStart, partEnd));
    }
    cursor = next;
  }

  return parts;
}

function parsePart(part) {
  const sepIdx = part.indexOf(HEADER_SEP);
  if (sepIdx === -1) return null;

  const headerText = part.subarray(0, sepIdx).toString('utf8');
  if (!headerText.includes('Content-Disposition: form-data')) return null;

  const body = part.subarray(sepIdx + HEADER_SEP.length);
  const nameMatch = headerText.match(/name="([^"]+)"/);
  const filenameMatch = headerText.match(/filename="([^"]*)"/);
  const contentTypeMatch = headerText.match(/Content-Type:\s*([^\r\n]+)/i);

  if (!nameMatch) return null;

  if (filenameMatch) {
    return {
      type: 'file',
      fieldname: nameMatch[1],
      originalname: filenameMatch[1],
      mimetype: contentTypeMatch ? contentTypeMatch[1].trim() : 'application/octet-stream',
      buffer: body,
      size: body.length,
    };
  }

  return {
    type: 'field',
    fieldname: nameMatch[1],
    value: body.toString('utf8'),
  };
}

export async function parseMultipartData(req, options = {}) {
  const { maxBodyBytes = null, maxFileBytes = null } = options;

  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=([^;]+)/);
    if (!boundaryMatch) {
      reject(new Error('No boundary found'));
      return;
    }
    const boundary = (boundaryMatch[1] || '').trim().replace(/^"|"$/g, '');

    let data = Buffer.alloc(0);
    let settled = false;
    const files = [];
    const fields = {};

    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    req.on('data', (chunk) => {
      if (maxBodyBytes != null && data.length + chunk.length > maxBodyBytes) {
        req.destroy();
        fail(new Error(`请求体超过限制 (${maxBodyBytes} 字节)`));
        return;
      }
      data = Buffer.concat([data, chunk]);
    });

    req.on('end', () => {
      if (settled) return;
      try {
        for (const part of splitMultipartBody(data, boundary)) {
          const parsed = parsePart(part);
          if (!parsed) continue;

          if (parsed.type === 'file') {
            if (maxFileBytes != null && parsed.size > maxFileBytes) {
              fail(new Error(`文件 ${parsed.originalname} 超过大小限制 (${maxFileBytes} 字节)`));
              return;
            }
            files.push({
              fieldname: parsed.fieldname,
              originalname: parsed.originalname,
              mimetype: parsed.mimetype,
              buffer: parsed.buffer,
              size: parsed.size,
            });
          } else {
            fields[parsed.fieldname] = parsed.value;
          }
        }

        settled = true;
        resolve({ files, fields });
      } catch (e) {
        fail(e);
      }
    });

    req.on('error', fail);
    req.on('aborted', () => fail(new Error('请求已中断')));
  });
}
