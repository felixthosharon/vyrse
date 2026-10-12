import crypto, { X509Certificate } from 'node:crypto'
import https from 'node:https'
import tls from 'node:tls'

/**
 * Verifies that a request really comes from Amazon's Alexa service, using only Node's crypto (no third-
 * party crypto library: the ask-sdk verifier pulled in node-forge, whose PKCS#1 checks had a known flaw).
 * Implements Amazon's documented checks for self-hosted skills:
 *  1. SignatureCertChainUrl is https://s3.amazonaws.com/echo.api/... (port 443 if given)
 *  2. the certificate chain from that URL is currently valid, the leaf names echo-api.amazon.com, and the
 *     chain ends at a trusted root authority
 *  3. Signature-256 is a valid SHA-256 RSA signature of the exact request body by that leaf
 *  4. the request timestamp is within 150 seconds
 */
const MAX_CERT_BYTES = 64 * 1024
const TOLERANCE_MS = 150_000
const cache = new Map<string, { chain: X509Certificate[]; until: number }>()

export function validCertUrl(raw: string | undefined): boolean {
  if (!raw) return false
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  return (
    url.protocol === 'https:' &&
    url.hostname.toLowerCase() === 's3.amazonaws.com' &&
    (url.port === '' || url.port === '443') &&
    url.pathname.startsWith('/echo.api/')
  )
}

export function parseChain(pem: string): X509Certificate[] {
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []
  return blocks.map(b => new X509Certificate(b))
}

let roots: X509Certificate[] | null = null
function trustedRoots(): X509Certificate[] {
  roots ??= tls.rootCertificates.flatMap(pem => {
    try {
      return [new X509Certificate(pem)]
    } catch {
      return []
    }
  })
  return roots
}

const current = (c: X509Certificate, now: number) => Date.parse(c.validFrom) <= now && now <= Date.parse(c.validTo)

/** Throws unless the chain is valid now, names echo-api.amazon.com and ends at a trusted root. */
export function checkChain(chain: X509Certificate[], now = Date.now(), anchors: X509Certificate[] = trustedRoots()): void {
  const leaf = chain[0]
  if (!leaf) throw new Error('no certificate')
  if (!(leaf.subjectAltName ?? '').split(/,\s*/).includes('DNS:echo-api.amazon.com')) throw new Error('certificate is not for echo-api.amazon.com')
  // Walk up from the leaf and stop at the first certificate that is, or is signed by, a trusted root (as
  // browsers do). Amazon's chain continues past "Amazon Root CA 1" to an older cross-signing root that
  // isn't in every trust store; what lies beyond the trust anchor doesn't matter.
  for (let i = 0; i < chain.length; i++) {
    const cert = chain[i]!
    if (!current(cert, now)) throw new Error('certificate expired or not yet valid')
    if (i > 0 && !cert.ca) throw new Error('issuer is not a certificate authority')
    const trustedHere = anchors.some(
      root =>
        root.fingerprint256 === cert.fingerprint256 ||
        (cert.checkIssued(root) && cert.verify(root.publicKey) && current(root, now)),
    )
    if (trustedHere) return
    const issuer = chain[i + 1]
    if (!issuer || !cert.checkIssued(issuer) || !cert.verify(issuer.publicKey)) break
  }
  throw new Error('certificate chain is not anchored in a trusted root')
}

export function checkSignature(body: string, signatureB64: string | undefined, leaf: X509Certificate): void {
  if (!signatureB64) throw new Error('no signature')
  const ok = crypto.verify('sha256', Buffer.from(body, 'utf8'), leaf.publicKey, Buffer.from(signatureB64, 'base64'))
  if (!ok) throw new Error('bad signature')
}

export function checkTimestamp(body: string, now = Date.now()): void {
  let ts: number
  try {
    ts = Date.parse((JSON.parse(body) as { request?: { timestamp?: string } }).request?.timestamp ?? '')
  } catch {
    throw new Error('bad body')
  }
  if (!Number.isFinite(ts) || Math.abs(now - ts) > TOLERANCE_MS) throw new Error('stale or missing timestamp')
}

function download(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 5000 }, res => {
      if (res.statusCode !== 200) {
        res.resume()
        return reject(new Error(`certificate download: HTTP ${res.statusCode}`))
      }
      let size = 0
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => {
        size += c.length
        if (size > MAX_CERT_BYTES) req.destroy(new Error('certificate too large'))
        else chunks.push(c)
      })
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    })
    req.on('timeout', () => req.destroy(new Error('certificate download timed out')))
    req.on('error', reject)
  })
}

async function chainFor(url: string): Promise<X509Certificate[]> {
  const hit = cache.get(url)
  if (hit && hit.until > Date.now()) return hit.chain
  const chain = parseChain(await download(url))
  checkChain(chain)
  // Re-check daily at most, and never past the leaf's expiry.
  cache.set(url, { chain, until: Math.min(Date.now() + 86_400_000, Date.parse(chain[0]!.validTo)) })
  return chain
}

/** Throws (with a short reason) unless the request is a genuine, fresh Alexa request. */
export async function verifyAmazonRequest(body: string, headers: Record<string, string | string[] | undefined>): Promise<void> {
  const header = (k: string) => {
    const v = headers[k]
    return Array.isArray(v) ? v[0] : v
  }
  checkTimestamp(body)
  const url = header('signaturecertchainurl')
  if (!validCertUrl(url)) throw new Error('bad certificate URL')
  const chain = await chainFor(new URL(url!).toString())
  checkChain(chain)
  checkSignature(body, header('signature-256'), chain[0]!)
}
