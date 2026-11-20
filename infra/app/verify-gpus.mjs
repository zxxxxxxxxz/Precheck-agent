// Run from the pinned official Node container on hsbc_app. Synthetic inputs only.
// Mount this script, the fixture and the selected token files read-only.
import fs from 'node:fs';
import crypto from 'node:crypto';

const scope = process.argv.find(value => value.startsWith('--only='))?.split('=')[1] ?? 'all';
const qwenModel = process.env.QWEN_MODEL ?? 'Qwen/Qwen3.5-9B';
if (!['Qwen/Qwen3.5-9B', 'Qwen/Qwen3.8-27B'].includes(qwenModel)) throw new Error('unsupported_qwen_model');
if (!['all', '3090', '5090'].includes(scope)) throw new Error('invalid_scope');
const services = {
  ocr: {base: 'http://autodl-3090:16006', tokenFile: '/run/secrets/ocr.token'},
  ner: {base: 'http://autodl-3090:16008', tokenFile: '/run/secrets/ner.token'},
  qwen: {
    base: (process.env.QWEN_BASE_URL ?? 'https://u334749-95be-0bf1cc76.bjb2.seetacloud.com:8443').replace(/\/v1\/?$/, ''),
    tokenFile: '/run/secrets/qwen-api.token',
  },
};
const selected = scope === '3090' ? ['ocr', 'ner'] : scope === '5090' ? ['qwen'] : Object.keys(services);
const startedAt = new Date().toISOString();
const tests = [];
const fixture = '/run/fixtures/synthetic-invoice.png';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
let fixtureSha256 = null;

async function request(service, name, route, options = {}) {
  const {auth = 'valid', payload, form, expected = 200, timeout = 15000, validate} = options;
  const test = {service, name, route, authenticated: auth === 'valid', expected_status: expected};
  const begin = Date.now();
  tests.push(test);
  try {
    const token = fs.readFileSync(services[service].tokenFile, 'utf8').trim();
    if (token.length < 32) throw new Error('invalid_token_file');
    const headers = {};
    if (auth !== 'none') headers.Authorization = `Bearer ${auth === 'valid' ? token : 'invalid-deployment-probe-token'}`;
    if (payload !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(services[service].base + route, {
      method: payload !== undefined || form ? 'POST' : 'GET', headers,
      body: form ?? (payload === undefined ? undefined : JSON.stringify(payload)),
      signal: AbortSignal.timeout(timeout), redirect: 'error',
    });
    test.status = response.status;
    const chunks = [];
    let length = 0;
    for await (const chunk of response.body ?? []) {
      length += chunk.length;
      if (length > 5 * 1024 * 1024) throw new Error('response_too_large');
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks);
    test.response_bytes = raw.length;
    if (response.status !== expected) throw new Error('unexpected_http_status');
    if (validate) {
      const result = JSON.parse(raw.toString('utf8'));
      Object.assign(test, validate(result));
      test.result_sha256 = hash(raw);
    }
    test.passed = true;
  } catch (error) {
    // Do not log response bodies, request text, tokens or arbitrary server errors.
    test.passed = false;
    test.error = ['invalid_token_file', 'response_too_large', 'unexpected_http_status',
      'invalid_model_result', 'fixture_missing'].includes(error.message) ? error.message : error.name;
  }
  test.elapsed_ms = Date.now() - begin;
  return test.passed;
}

function requireResult(condition) {
  if (!condition) throw new Error('invalid_model_result');
}

for (const service of selected) {
  await request(service, 'missing_token_rejected', '/health/ready', {auth: 'none', expected: 401});
  await request(service, 'wrong_token_rejected', '/health/ready', {auth: 'invalid', expected: 401});
  const ready = await request(service, 'model_ready', '/health/ready', service === 'qwen' ? {} : {
    validate: result => {
      requireResult(result.status === 'ready' && result.service === service);
      return {ready: true};
    },
  });
  if (!ready) continue;

  if (service === 'ocr') {
    try {
      const image = fs.readFileSync(fixture);
      requireResult(image.length >= 24 && image.subarray(1, 4).toString() === 'PNG');
      const fixtureWidth = image.readUInt32BE(16), fixtureHeight = image.readUInt32BE(20);
      fixtureSha256 = hash(image);
      const form = new FormData();
      form.append('file', new Blob([image], {type: 'image/png'}), 'synthetic-invoice.png');
      await request(service, 'synthetic_invoice_ocr', '/v1/ocr', {form, timeout: 180000,
        validate: result => {
          const pages = result.pages;
          requireResult(Array.isArray(pages) && pages.length > 0);
          const markdown = pages.map(page => page.markdown ?? '').join('\n');
          requireResult(markdown.includes('INVOICE') && markdown.includes('100'));
          return {pages: pages.length, extracted_characters: markdown.length, expected_markers_found: true};
        },
      });
      const wordForm = new FormData();
      wordForm.append('file', new Blob([image], {type: 'image/png'}), 'synthetic-invoice.png');
      wordForm.append('return_word_box', 'true');
      await request(service, 'synthetic_invoice_word_coordinates', '/v1/ocr', {
        form: wordForm, timeout: 180000,
        validate: result => {
          const page = result.pages?.[0];
          const word = page?.word_ocr;
          requireResult(page?.result && typeof page.markdown === 'string' &&
            word?.coordinate_system === 'original_image_pixels' &&
            word.method === 'ctc_alignment' && word.model === 'PP-OCRv6' &&
            word.width === fixtureWidth && word.height === fixtureHeight);
          requireResult(Array.isArray(word.text_word) && word.text_word.length > 0 &&
            word.text_word.length === word.text_word_boxes?.length &&
            word.text_word.length === word.text_word_region?.length);
          let units = 0;
          for (let line = 0; line < word.text_word.length; line++) {
            const words = word.text_word[line];
            const boxes = word.text_word_boxes[line];
            const regions = word.text_word_region[line];
            requireResult(Array.isArray(words) && words.length === boxes?.length && words.length === regions?.length);
            for (let index = 0; index < words.length; index++) {
              const box = boxes[index], region = regions[index];
              requireResult(typeof words[index] === 'string' &&
                Array.isArray(box) && box.length === 4 && box.every(Number.isFinite) &&
                box[0] <= box[2] && box[1] <= box[3] &&
                Array.isArray(region) && region.length === 4 &&
                region.every(point => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite)));
              units++;
            }
          }
          requireResult(units > word.text_word.length);
          return {pages: result.pages.length, word_units: units, coordinate_shapes_valid: true};
        },
      });
    } catch {
      tests.push({service, name: 'synthetic_invoice_ocr', passed: false, error: 'fixture_missing'});
    }
  }

  if (service === 'ner') {
    await request(service, 'english_entities', '/v1/entities', {timeout: 120000, payload: {
      text: 'Apple CEO Tim Cook announced iPhone 15 in Cupertino yesterday.',
      labels: ['company', 'person', 'product', 'location'], word_splitter: 'whitespace',
    }, validate: result => {
      requireResult(result.entities?.person?.some(entity => entity.text === 'Tim Cook') &&
        result.entities?.location?.some(entity => entity.text === 'Cupertino'));
      return {entity_count: Object.values(result.entities).reduce((count, values) => count + values.length, 0),
        expected_entities_found: true};
    }});
    await request(service, 'chinese_entities', '/v1/entities', {timeout: 120000, payload: {
      text: '张三在汇丰银行工作，公司位于上海。', labels: ['人名', '公司', '地点'], word_splitter: 'char',
    }, validate: result => {
      requireResult(result.entities?.人名?.some(entity => entity.text === '张三') &&
        result.entities?.公司?.some(entity => entity.text === '汇丰银行'));
      return {entity_count: Object.values(result.entities).reduce((count, values) => count + values.length, 0),
        expected_entities_found: true};
    }});
    await request(service, 'synthetic_invoice_classification', '/v1/classify', {timeout: 120000, payload: {
      text: 'DEMO INVOICE. Invoice number DEMO-001. Total amount USD 100.00.',
      labels: ['invoice', 'employment contract', 'shipping document'],
    }, validate: result => {
      requireResult(result.label?.label === 'invoice');
      return {expected_class_found: true};
    }});
  }

  if (service === 'qwen') {
    await request(service, 'restricted_route_rejected', '/metrics', {expected: 404});
    await request(service, 'model_identity', '/v1/models', {validate: result => {
      requireResult(result.data?.some(model => model.id === qwenModel));
      return {expected_model_found: true};
    }});
    await request(service, 'synthetic_chat_completion', '/v1/chat/completions', {
      timeout: 180000, payload: {
        model: qwenModel, messages: [{role: 'user', content: 'Reply with exactly: DEPLOY_OK'}],
        chat_template_kwargs: {enable_thinking: false}, temperature: 0, max_tokens: 32,
      }, validate: result => {
        const content = result.choices?.[0]?.message?.content;
        requireResult(typeof content === 'string' && content.includes('DEPLOY_OK'));
        return {output_characters: content.length, expected_marker_found: true,
          completion_tokens: result.usage?.completion_tokens ?? null};
      },
    });
  }
}

const report = {
  schema_version: 1, started_at: startedAt, finished_at: new Date().toISOString(),
  scope, all_services_checked: scope === 'all', synthetic_data_only: true,
  node_version: process.version, fixture_sha256: fixtureSha256, tests,
  passed: tests.length > 0 && tests.every(test => test.passed),
};
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
