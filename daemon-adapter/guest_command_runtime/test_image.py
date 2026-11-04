import gzip
import stat
import struct
import unittest
from image import APPLETS, ImageError, build_initramfs


def elf():
    data=bytearray(120)
    data[:7]=b'\x7fELF\x02\x01\x01'
    struct.pack_into('<HH',data,16,2,183)
    struct.pack_into('<I',data,20,1)
    struct.pack_into('<Q',data,24,0x400040)
    struct.pack_into('<Q',data,32,64)
    struct.pack_into('<H',data,52,64)
    struct.pack_into('<HH',data,54,56,1)
    struct.pack_into('<IIQQQQQQ',data,64,1,5,0,0x400000,0x400000,120,120,4096)
    return bytes(data)


def unpack(blob):
    data=gzip.decompress(blob);position=0;entries={}
    while True:
        assert data[position:position+6]==b'070701'
        fields=[int(data[position+6+i*8:position+14+i*8],16) for i in range(13)]
        position+=110
        name=data[position:position+fields[11]-1].decode('ascii')
        position+=fields[11];position=(position+3)&~3
        payload=data[position:position+fields[6]]
        position+=fields[6];position=(position+3)&~3
        entries[name]=(fields,payload)
        if name=='TRAILER!!!':return entries


class ImageTests(unittest.TestCase):
    def test_fixed_layout_and_reproducible_archive(self):
        executable=elf();first=build_initramfs(executable,executable)
        self.assertEqual(first,build_initramfs(executable,executable))
        files=unpack(first)
        self.assertEqual(files['init'][1],executable)
        self.assertEqual(files['bin/busybox'][1],executable)
        for name in APPLETS:
            self.assertTrue(stat.S_ISLNK(files['bin/'+name][0][1]))
            self.assertEqual(files['bin/'+name][1],b'busybox')
        self.assertEqual(files['tmp'][1],b'/work/tmp')
        self.assertEqual(files['dev/null'][0][9:11],[1,3])
        self.assertEqual(files['dev/console'][0][9:11],[5,1])
        self.assertEqual(files['dev/console'][0][1],stat.S_IFCHR|0o600)
        for fields,_ in files.values():self.assertEqual(fields[2:4],[0,0])
        self.assertFalse(any('..' in key.split('/') for key in files))

    def test_dynamic_and_wrong_arch_executables_rejected(self):
        original=elf()
        for offset,value,fmt in [(18,62,'<H'),(64,3,'<I'),(64,2,'<I'),(32,10000,'<Q'),
                                 (20,0,'<I'),(24,0,'<Q'),(24,0x500000,'<Q'),
                                 (52,0,'<H'),(54,64,'<H'),(112,3,'<Q'),
                                 (80,(1<<64)-1,'<Q')]:
            with self.subTest(offset=offset,value=value):
                invalid=bytearray(original);struct.pack_into(fmt,invalid,offset,value)
                with self.assertRaises(ImageError):build_initramfs(bytes(invalid),original)

    def test_nonbytes_and_truncated_input_rejected(self):
        for value in [b'',b'ELF',bytearray(elf()),None]:
            with self.subTest(value=type(value)):
                with self.assertRaises(ImageError):build_initramfs(value,elf())


if __name__=='__main__':unittest.main()
