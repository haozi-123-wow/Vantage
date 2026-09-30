package main

import (
	"encoding/binary"
	"fmt"
)

func checksum(b []byte) uint16 {
	var sum uint32
	for i := 0; i+1 < len(b); i += 2 {
		sum += uint32(binary.BigEndian.Uint16(b[i : i+2]))
	}
	if len(b)%2 == 1 {
		sum += uint32(b[len(b)-1]) << 8
	}
	for sum>>16 != 0 {
		sum = (sum & 0xffff) + (sum >> 16)
	}
	return ^uint16(sum)
}

func main() {
	// A. echo 头 8 字节（校验和字段为 0）：08 00 00 00 12 34 00 01
	a := []byte{0x08, 0x00, 0x00, 0x00, 0x12, 0x34, 0x00, 0x01}
	fmt.Printf("A head8        cksum=%#04x\n", checksum(a))

	// B. 完整报文：头 + payload 0x00..0x0f
	b := make([]byte, 24)
	b[0] = 8
	b[4], b[5] = 0x12, 0x34
	b[6], b[7] = 0x00, 0x01
	for i := 8; i < 24; i++ {
		b[i] = byte(i - 8)
	}
	fmt.Printf("B full24       cksum=%#04x\n", checksum(b))

	// C. 奇数长度 3 字节 00 01 02 与补零后的 4 字节
	fmt.Printf("C odd3         cksum=%#04x\n", checksum([]byte{0x00, 0x01, 0x02}))
	fmt.Printf("C even4        cksum=%#04x\n", checksum([]byte{0x00, 0x01, 0x02, 0x00}))
	fmt.Printf("C f203         cksum=%#04x\n", checksum([]byte{0x00, 0x01, 0xf2, 0x03}))
	fmt.Printf("C zero4        cksum=%#04x\n", checksum([]byte{0, 0, 0, 0}))
}
