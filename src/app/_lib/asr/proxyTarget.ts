import { lookup, type LookupAddress } from 'node:dns';
import { BlockList, isIP, type LookupFunction } from 'node:net';

/** 공개 주소가 아닌 대상 — 호스트 이름이 내부 주소로 풀린 경우도 여기로 온다 */
export class BlockedTargetError extends Error {}

const PRIVATE_HOSTNAME = /(^|\.)(localhost|local|internal|intranet|lan|home\.arpa)$/i;

const IPV4_RESERVED: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
];

/** 전역 유니캐스트(2000::/3) 밖은 전부 막는다 — IPv4-mapped·링크 로컬·ULA 가 모두 여기 든다 */
const IPV6_RESERVED: [string, number][] = [
  ['::', 3],
  ['4000::', 2],
  ['8000::', 1],
  ['2001::', 32],
  ['2001:db8::', 32],
  ['2002::', 16],
];

/** 한 목록에 섞으면 IPv4 주소가 IPv4-mapped 로 바뀌어 IPv6 규칙에도 걸린다 */
const reservedIpv4 = new BlockList();
const reservedIpv6 = new BlockList();
for (const [address, prefix] of IPV4_RESERVED) reservedIpv4.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of IPV6_RESERVED) reservedIpv6.addSubnet(address, prefix, 'ipv6');

export const isPublicAddress = (address: string): boolean => {
  const family = isIP(address);
  if (family === 4) return !reservedIpv4.check(address, 'ipv4');
  return family === 6 && !reservedIpv6.check(address, 'ipv6');
};

/** URL 단계 검사 — 주소가 그대로 적힌 대상은 DNS 를 거치지 않으므로 여기서 걸러야 한다 */
export const parseProxyTarget = (raw: string | null): URL | null => {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (PRIVATE_HOSTNAME.test(host)) return null;
    return isIP(host) === 0 || isPublicAddress(host) ? url : null;
  } catch {
    return null;
  }
};

/** 운영자가 정한 대상만 허용한다. 비워 두면 공개 주소 전체를 허용하고, `.example.com` 처럼 쓰면 하위 도메인을 뜻한다 */
export const isAllowedHost = (hostname: string, allowed = process.env.ASR_PROXY_ALLOWED_HOSTS ?? ''): boolean => {
  const hosts = allowed.split(',').map((host) => host.trim().toLowerCase()).filter(Boolean);
  if (hosts.length === 0) return true;
  const host = hostname.toLowerCase();
  return hosts.some((entry) => (entry.startsWith('.') ? host.endsWith(entry) : host === entry));
};

/**
 * 연결할 때 쓰는 주소를 그 자리에서 검사한다. 미리 조회해 두면 그사이 DNS 답이 바뀔 수 있어 소켓의 lookup 을 대신한다.
 * 답 가운데 하나라도 내부 주소면 전체를 거부한다.
 */
export const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { ...options, all: true }, (error, addresses: LookupAddress[]) => {
    if (error) {
      callback(error, '', 0);
      return;
    }
    if (addresses.length === 0 || !addresses.every(({ address }) => isPublicAddress(address))) {
      callback(new BlockedTargetError(hostname), '', 0);
      return;
    }
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  });
};