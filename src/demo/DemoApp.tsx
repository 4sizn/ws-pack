import { ChatRoom } from './components/ChatRoom'
import { mockRooms } from './data/mockRooms'
import './styles/chat.css'

export function DemoApp() {
  return (
    <main className="demo-page">
      <div className="demo-page__head">
        <h1>ws-pack 데모</h1>
        <p>카카오톡 스타일 채팅방 3개. 현재는 UI만 동작하며 목 데이터를 사용한다.</p>
      </div>

      <div className="room-rail">
        {mockRooms.map((room) => (
          <ChatRoom key={room.id} room={room} />
        ))}
      </div>
    </main>
  )
}
