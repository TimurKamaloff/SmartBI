import Image from 'next/image';

export default function LogoBar() {
  return (
    <Image
      src="/images/logo_SmartBi.svg"
      alt="SmartBI"
      width={100}
      height={30}
    />
  );
}
