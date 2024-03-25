/*
Copyright © 2024 SUSE LLC
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

	http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/
package utils

import (
	"io"
	"net"

	"github.com/sirupsen/logrus"
)

func Pipe(conn net.Conn, upstreamAddr string) {
	upstream, err := net.Dial("tcp", upstreamAddr)
	if err != nil {
		logrus.Errorf("Failed to dial upstream %s: %s", upstreamAddr, err)
		return
	}
	defer upstream.Close()

	go func() {
		if _, err := io.Copy(upstream, conn); err != nil {
			logrus.Debugf("Error copying to upstream: %s", err)
		}
	}()

	if _, err := io.Copy(conn, upstream); err != nil {
		logrus.Debugf("Error copying from upstream: %s", err)
	}
}
