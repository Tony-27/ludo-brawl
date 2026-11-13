using LudoBrawl.Api.Models;

namespace LudoBrawl.Api.Services;

public interface IRoomService
{
    Room CreateRoom(string hostName);
    Player JoinRoom(string playerName, string roomCode);
    void LeaveRoom(string playerToken, string roomCode);
    Room? GetRoom(string roomCode);
}